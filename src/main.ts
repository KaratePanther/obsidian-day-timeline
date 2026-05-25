import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DayTimelineView, VIEW_TYPE } from "./timeline-view";

export default class DayTimelinePlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new DayTimelineView(leaf));

    this.addRibbonIcon("calendar-clock", "Day Timeline", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-day-timeline",
      name: "Open Day Timeline",
      callback: () => this.activateView(),
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshTimeline();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        const view = this.getTimelineView();
        if (!view) return;
        if (view.handler?.shouldSuppressModify) return;
        this.refreshTimeline();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshTimeline();
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      this.refreshTimeline();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.refreshTimeline();
  }

  private getTimelineView(): DayTimelineView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length === 0) return null;
    return leaves[0].view as DayTimelineView;
  }

  private refreshTimeline(): void {
    const view = this.getTimelineView();
    if (!view) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      view.refresh(activeFile);
    }
  }
}
