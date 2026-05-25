import { ItemView, TFile, WorkspaceLeaf, MarkdownView } from "obsidian";
import { DailyNote } from "./types";
import { parseDaily, getAllTasks } from "./parser";
import { renderTimeline, updateNowLine, RenderedElements } from "./timeline-renderer";
import { DragHandler } from "./drag-handler";

export const VIEW_TYPE = "day-timeline-view";

export class DayTimelineView extends ItemView {
  private nowInterval: ReturnType<typeof setInterval> | null = null;
  private elements: RenderedElements | null = null;
  private dragHandler: DragHandler | null = null;
  private currentFile: TFile | null = null;
  private daily: DailyNote | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Day Timeline";
  }

  getIcon(): string {
    return "calendar-clock";
  }

  async onOpen(): Promise<void> {
    this.renderEmpty();
    this.nowInterval = setInterval(() => {
      if (this.elements) {
        updateNowLine(this.elements.nowLine);
      }
    }, 60_000);
  }

  async onClose(): Promise<void> {
    if (this.nowInterval) {
      clearInterval(this.nowInterval);
      this.nowInterval = null;
    }
  }

  renderEmpty(): void {
    this.elements = renderTimeline(this.contentEl, null);
  }

  async refresh(file: TFile): Promise<void> {
    if (!this.isDailyNote(file)) {
      if (!this.currentFile) this.renderEmpty();
      return;
    }

    this.currentFile = file;
    const content = await this.app.vault.read(file);
    this.daily = parseDaily(content, file.path);

    const gridEl = this.contentEl.querySelector(".day-timeline-grid") as HTMLElement | null;
    const savedScroll = gridEl?.scrollTop ?? 0;

    this.elements = renderTimeline(this.contentEl, this.daily);

    const newGridEl = this.contentEl.querySelector(".day-timeline-grid") as HTMLElement | null;
    if (newGridEl) {
      newGridEl.scrollTop = savedScroll;
    }

    this.setupClickToNavigate();

    this.dragHandler = new DragHandler(
      this.app,
      file,
      this.daily,
      this.elements,
      () => this.refresh(file)
    );
    this.dragHandler.setup();
  }

  get handler(): DragHandler | null {
    return this.dragHandler;
  }

  private setupClickToNavigate(): void {
    if (!this.elements || !this.daily) return;

    const allBlocks = [
      ...this.elements.taskBlocks.entries(),
      ...this.elements.poolItems.entries(),
    ];

    for (const [taskId, el] of allBlocks) {
      el.addEventListener("click", (e) => {
        const targetCls = (e.target as HTMLElement).className;
        if (targetCls.includes("task-block-resize")) return;

        const task = getAllTasks(this.daily!).find((t) => t.id === taskId);
        if (!task) return;

        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mdView && mdView.file === this.currentFile) {
          mdView.editor.setCursor(task.lineStart, 0);
          mdView.editor.scrollIntoView(
            { from: { line: task.lineStart, ch: 0 }, to: { line: task.lineStart, ch: 0 } },
            true
          );
        }
      });
    }
  }

  private isDailyNote(file: TFile): boolean {
    return /daily notes\/\d{4}-\d{2}-\d{2}\.md$/.test(file.path);
  }
}
