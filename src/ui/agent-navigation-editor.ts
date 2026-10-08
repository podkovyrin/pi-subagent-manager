import {
  CustomEditor,
  type CustomEditorOptions,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Key,
  matchesKey,
  type EditorTheme,
  type Keybinding,
  type TUI,
} from "@earendil-works/pi-tui";

export interface AgentNavigationEditorOptions {
  /** Must return the whole navigation interaction, so repeated Left cannot reopen it. */
  openTree(): void | Promise<void>;
  canOpen(): boolean;
  /** Session-local widget collapse; never saves the configured display mode. */
  collapseWidget?(): void | Promise<void>;
  canCollapse?(): boolean;
  /** Root ownership token; changing it invalidates queued transitions. */
  generation(): unknown;
  onError?(error: unknown): void;
  /**
   * Chronological user prompts for reload/new/resume/fork. Omit on startup:
   * Pi hydrates the installed editor after the startup session_start event.
   */
  initialHistory?: readonly string[];
}

/** Public editor surface used by arrow navigation; every CustomEditor provides it. */
export type NavigableEditor = Pick<
  CustomEditor,
  | "handleInput"
  | "getCursor"
  | "getText"
  | "isShowingAutocomplete"
  | "addToHistory"
  | "onChange"
  | "onExtensionShortcut"
  | "focused"
>;

function isNavigableEditor(editor: unknown): editor is NavigableEditor {
  const value = editor as Partial<Record<keyof NavigableEditor, unknown>> | undefined;
  return (
    typeof value?.handleInput === "function" &&
    typeof value.getCursor === "function" &&
    typeof value.getText === "function" &&
    typeof value.isShowingAutocomplete === "function" &&
    typeof value.addToHistory === "function"
  );
}

/**
 * Physical arrow boundary adapter. It owns no session/history internals and never
 * changes the draft. Install once per root UI lifecycle, not for tree navigation.
 * It runs on top of exactly one stock dispatch, so it can sit on our own editor
 * or decorate an editor that another extension installed in the single host slot.
 */
class ArrowNavigation {
  private pending: "left" | "right" | undefined;
  private disposed = false;
  private dispatchDepth = 0;
  private inputEpoch = 0;
  private pastePending = false;
  private jumpPending = false;

  constructor(
    private editor: NavigableEditor,
    private navigationKeys: KeybindingsManager,
    private navigation: AgentNavigationEditorOptions,
  ) {
    // SessionStartEvent.reason distinguishes startup (host hydrates AFTER
    // installation) from reload/replacement (explicit public hydration needed).
    // Never infer replay from prompt text: intentional repetitions are valid.
    for (const text of navigation.initialHistory ?? []) editor.addToHistory(text);
  }

  /** Invalidates queued work without resetting a competing extension's editor. */
  dispose(): void {
    this.disposed = true;
    this.inputEpoch++;
  }

  private ordinaryArrow(data: string, direction: "left" | "right"): boolean {
    if (!matchesKey(data, direction === "left" ? Key.left : Key.right)) return false;
    const action = direction === "left" ? "tui.editor.cursorLeft" : "tui.editor.cursorRight";
    // Editor uses the global TUI bindings; CustomEditor uses the injected app
    // manager. Both must agree, and a conflicting remap wins conservatively.
    for (const keys of [this.navigationKeys, getKeybindings()]) {
      if (!keys.matches(data, action)) return false;
      for (const other of Object.keys(keys.getResolvedBindings())) {
        if (
          other !== action &&
          (other.startsWith("tui.editor.") ||
            other.startsWith("tui.input.") ||
            other.startsWith("tui.altScreen.") ||
            other.startsWith("app.")) &&
          keys.matches(data, other as Keybinding)
        )
          return false;
      }
    }
    return true;
  }

  handle(data: string, dispatch: (data: string) => void): void {
    const editor = this.editor;
    const outer = this.dispatchDepth === 0;
    const direction = this.ordinaryArrow(data, "left") ? "left"
      : this.ordinaryArrow(data, "right") ? "right" : undefined;
    if (outer && (!direction || (this.pending && this.pending !== direction))) this.inputEpoch++;
    const previousPaste = this.pastePending;
    const wasPaste = previousPaste || data.includes("\x1b[200~");
    // Update before dispatch: Pi recursively sends a suffix after the end
    // marker through this.handleInput, and that suffix is no longer paste.
    if (data.includes("\x1b[200~")) this.pastePending = true;
    if (wasPaste && data.includes("\x1b[201~")) this.pastePending = false;
    const wasJump = this.jumpPending;
    const cursor = editor.getCursor();
    const text = editor.getText();
    const lines = text.split("\n");
    const atBoundary = direction === "left"
      ? cursor.line === 0 && cursor.col === 0
      : direction === "right" && cursor.line === lines.length - 1 &&
        cursor.col === lines.at(-1)!.length;
    const eligible =
      outer &&
      direction !== undefined &&
      editor.focused &&
      !this.disposed &&
      !wasPaste &&
      !wasJump &&
      !editor.isShowingAutocomplete() &&
      atBoundary;
    const generation = eligible ? this.navigation.generation() : undefined;
    let changed = false;
    let consumed = false;
    const originalChange = editor.onChange;
    const originalShortcut = editor.onExtensionShortcut;
    const observeChange = (value: string) => {
      changed = true;
      originalChange?.call(editor, value);
    };
    const observeShortcut = (value: string) => {
      const handled = originalShortcut?.call(editor, value) ?? false;
      consumed ||= handled && value === data;
      return handled;
    };
    editor.onChange = observeChange;
    editor.onExtensionShortcut = observeShortcut;
    this.dispatchDepth++;
    try {
      // Exactly one stock dispatch, preserving host-wired application controls.
      dispatch(data);
    } finally {
      this.dispatchDepth--;
      if (editor.onChange === observeChange) editor.onChange = originalChange;
      if (editor.onExtensionShortcut === observeShortcut) editor.onExtensionShortcut = originalShortcut;
      if (consumed) this.pastePending = previousPaste;
      if (!consumed) {
        // Track only public input; over-suppress when precedence is ambiguous.
        // Recursive paste suffix dispatch updates guards, but never opens UI.
        if (!wasPaste) {
          const keys = getKeybindings();
          const jump =
            keys.matches(data, "tui.editor.jumpForward") ||
            keys.matches(data, "tui.editor.jumpBackward");
          this.jumpPending = !wasJump && jump;
        }
      }
    }
    const after = editor.getCursor();
    if (
      eligible &&
      !consumed &&
      !changed &&
      !editor.isShowingAutocomplete() &&
      editor.getText() === text &&
      after.line === cursor.line &&
      after.col === cursor.col
    ) {
      this.queueNavigation(text, cursor, generation, direction!);
    }
  }

  private queueNavigation(
    text: string,
    cursor: { line: number; col: number },
    generation: unknown,
    direction: "left" | "right",
  ): void {
    const allowed = () => direction === "left"
      ? this.navigation.canOpen()
      : !!this.navigation.collapseWidget && (this.navigation.canCollapse?.() ?? false);
    if (this.pending || !allowed()) return;
    this.pending = direction;
    const epoch = this.inputEpoch;
    queueMicrotask(() => {
      const after = this.editor.getCursor();
      if (
        this.disposed ||
        !this.editor.focused ||
        this.inputEpoch !== epoch ||
        this.navigation.generation() !== generation ||
        !allowed() ||
        this.editor.isShowingAutocomplete() ||
        this.editor.getText() !== text ||
        after.line !== cursor.line ||
        after.col !== cursor.col
      ) {
        this.pending = undefined;
        return;
      }
      try {
        // Call within the checked microtask: an extra Promise.then would leave
        // a gap in which root ownership could change after validation.
        void Promise.resolve(direction === "left"
          ? this.navigation.openTree() : this.navigation.collapseWidget!())
          .catch((error: unknown) => this.navigation.onError?.(error))
          .finally(() => {
            this.pending = undefined;
          });
      } catch (error) {
        this.pending = undefined;
        this.navigation.onError?.(error);
      }
    });
  }
}

/**
 * Default editor when no other extension owns the host slot.
 * Another custom editor is decorated with attachAgentNavigation instead.
 */
export class AgentNavigationEditor extends CustomEditor {
  private arrows: ArrowNavigation;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    navigationKeys: KeybindingsManager,
    navigation: AgentNavigationEditorOptions,
    options?: CustomEditorOptions,
  ) {
    super(tui, theme, navigationKeys, options);
    this.arrows = new ArrowNavigation(this, navigationKeys, navigation);
  }

  /** Invalidates queued work without resetting a competing extension's editor. */
  dispose(): void {
    this.arrows.dispose();
  }

  override handleInput(data: string): void {
    this.arrows.handle(data, (value) => super.handleInput(value));
  }
}

export interface AgentNavigationHandle {
  dispose(): void;
}

/**
 * Adds arrow navigation to an editor that another extension created, so both
 * share the single custom-editor slot. The editor keeps its own rendering and
 * input; only its public handleInput is wrapped. Returns undefined, and leaves
 * the editor untouched, if it does not expose the public CustomEditor surface.
 */
export function attachAgentNavigation(
  editor: unknown,
  navigationKeys: KeybindingsManager,
  navigation: AgentNavigationEditorOptions,
): AgentNavigationHandle | undefined {
  if (!isNavigableEditor(editor)) return undefined;
  const arrows = new ArrowNavigation(editor, navigationKeys, navigation);
  const original = editor.handleInput;
  const wrapped = function (this: NavigableEditor, data: string) {
    arrows.handle(data, (value) => original.call(editor, value));
  };
  editor.handleInput = wrapped;
  return {
    dispose() {
      arrows.dispose();
      // Do not undo a later wrapper that another extension added on top.
      if (editor.handleInput === wrapped) editor.handleInput = original;
    },
  };
}
