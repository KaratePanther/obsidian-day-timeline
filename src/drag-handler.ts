import { App, TFile } from "obsidian";
import { DailyNote, Task, TimeRange } from "./types";
import { parseDaily, getAllTasks } from "./parser";
import { addSchedule, removeSchedule, updateSchedule } from "./serializer";
import {
  RenderedElements,
  yToTime,
  HOUR_HEIGHT,
  DAY_START,
  DEFAULT_DURATION,
  SNAP_MINUTES,
  snapToGrid,
} from "./timeline-renderer";

export type RefreshCallback = () => void;

export class DragHandler {
  private app: App;
  private file: TFile;
  private daily: DailyNote;
  private elements: RenderedElements;
  private onRefresh: RefreshCallback;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;
  private suppressNextModify = false;
  private grabOffsetY = 0;

  constructor(
    app: App,
    file: TFile,
    daily: DailyNote,
    elements: RenderedElements,
    onRefresh: RefreshCallback
  ) {
    this.app = app;
    this.file = file;
    this.daily = daily;
    this.elements = elements;
    this.onRefresh = onRefresh;
  }

  get shouldSuppressModify(): boolean {
    const val = this.suppressNextModify;
    this.suppressNextModify = false;
    return val;
  }

  setup(): void {
    this.setupPoolDrag();
    this.setupBlockDrag();
    this.setupResizeBottom();
    this.setupResizeTop();
    this.setupGridDrop();
    this.setupPoolDrop();
  }

  private setupPoolDrag(): void {
    for (const [taskId, item] of this.elements.poolItems) {
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/plain", taskId);
        e.dataTransfer!.setData("application/day-timeline-pool", "1");
        this.grabOffsetY = 0;
        item.addClass("is-dragging");
      });
      item.addEventListener("dragend", () => {
        item.removeClass("is-dragging");
      });
    }
  }

  private setupBlockDrag(): void {
    for (const [taskId, block] of this.elements.taskBlocks) {
      const handle = block.querySelector(".task-block-handle") as HTMLElement;
      if (!handle) continue;

      handle.addEventListener("mousedown", (e) => {
        block.setAttribute("draggable", "true");
        this.grabOffsetY = e.clientY - block.getBoundingClientRect().top;
      });

      block.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/plain", taskId);
        e.dataTransfer!.setData("application/day-timeline-block", "1");
        block.addClass("is-dragging");
      });

      block.addEventListener("dragend", () => {
        block.removeClass("is-dragging");
        block.setAttribute("draggable", "false");
      });
    }
  }

  private setupGridDrop(): void {
    const grid = this.elements.slotsContainer;

    grid.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      grid.addClass("drag-over");
    });

    grid.addEventListener("dragleave", () => {
      grid.removeClass("drag-over");
    });

    grid.addEventListener("drop", async (e) => {
      e.preventDefault();
      grid.removeClass("drag-over");

      const taskId = e.dataTransfer!.getData("text/plain");
      const isFromPool = e.dataTransfer!.types.includes("application/day-timeline-pool");
      if (!taskId) return;

      const rect = grid.getBoundingClientRect();
      const rawY = e.clientY - rect.top + grid.scrollTop - this.grabOffsetY;
      const dropTime = yToTime(Math.max(0, rawY));

      const task = this.findTask(taskId);
      if (!task) return;

      if (isFromPool) {
        const endMinutes = dropTime.hour * 60 + dropTime.minute + DEFAULT_DURATION;
        const newTime: TimeRange = {
          start: dropTime,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };
        await this.writeChange((content) =>
          addSchedule(content, task.lineStart, newTime)
        );
      } else {
        const duration = this.getTaskDuration(task);
        const endMinutes = dropTime.hour * 60 + dropTime.minute + duration;
        const newTime: TimeRange = {
          start: dropTime,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };
        await this.writeChange((content) =>
          updateSchedule(content, task.lineStart, newTime)
        );
      }
    });
  }

  private setupPoolDrop(): void {
    const pool = this.elements.pool;

    pool.addEventListener("dragover", (e) => {
      if (!e.dataTransfer!.types.includes("application/day-timeline-block")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      pool.addClass("drag-over");
    });

    pool.addEventListener("dragleave", () => {
      pool.removeClass("drag-over");
    });

    pool.addEventListener("drop", async (e) => {
      e.preventDefault();
      pool.removeClass("drag-over");

      const taskId = e.dataTransfer!.getData("text/plain");
      if (!taskId) return;

      const task = this.findTask(taskId);
      if (!task || !task.scheduledTime) return;

      await this.writeChange((content) =>
        removeSchedule(content, task.lineStart)
      );
    });
  }

  private setupResizeBottom(): void {
    for (const [taskId, block] of this.elements.taskBlocks) {
      const resizeHandle = block.querySelector(".task-block-resize") as HTMLElement;
      if (!resizeHandle) continue;

      let startY = 0;
      let startHeight = 0;

      const onMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        const dy = e.clientY - startY;
        const rawMinutes = ((startHeight + dy) / HOUR_HEIGHT) * 60;
        const snappedMinutes = Math.max(
          SNAP_MINUTES,
          snapToGrid(rawMinutes)
        );
        block.style.height = `${(snappedMinutes / 60) * HOUR_HEIGHT}px`;
      };

      const onMouseUp = async () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        block.removeClass("is-resizing");

        const task = this.findTask(taskId);
        if (!task || !task.scheduledTime) return;

        const finalHeight = parseFloat(block.style.height);
        const durationMinutes = snapToGrid((finalHeight / HOUR_HEIGHT) * 60);
        const endMinutes =
          task.scheduledTime.start.hour * 60 +
          task.scheduledTime.start.minute +
          durationMinutes;

        const newTime: TimeRange = {
          start: task.scheduledTime.start,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        await this.writeChange((content) =>
          updateSchedule(content, task.lineStart, newTime)
        );
      };

      resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startY = e.clientY;
        startHeight = block.offsetHeight;
        block.addClass("is-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    }
  }

  private setupResizeTop(): void {
    for (const [taskId, block] of this.elements.taskBlocks) {
      const resizeHandle = block.querySelector(".task-block-resize-top") as HTMLElement;
      if (!resizeHandle) continue;

      let startY = 0;
      let origTop = 0;
      let origHeight = 0;

      const onMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        const dy = e.clientY - startY;
        const newTop = origTop + dy;
        const newHeight = origHeight - dy;

        const rawMinutes = (newHeight / HOUR_HEIGHT) * 60;
        const snappedMinutes = Math.max(SNAP_MINUTES, snapToGrid(rawMinutes));
        const snappedHeight = (snappedMinutes / 60) * HOUR_HEIGHT;
        const snappedTop = origTop + origHeight - snappedHeight;

        block.style.top = `${snappedTop}px`;
        block.style.height = `${snappedHeight}px`;
      };

      const onMouseUp = async () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        block.removeClass("is-resizing");

        const task = this.findTask(taskId);
        if (!task || !task.scheduledTime) return;

        const finalTop = parseFloat(block.style.top);
        const finalHeight = parseFloat(block.style.height);

        const newStart = yToTime(finalTop);
        const durationMinutes = snapToGrid((finalHeight / HOUR_HEIGHT) * 60);
        const endMinutes = newStart.hour * 60 + newStart.minute + durationMinutes;

        const newTime: TimeRange = {
          start: newStart,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        await this.writeChange((content) =>
          updateSchedule(content, task.lineStart, newTime)
        );
      };

      resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startY = e.clientY;
        origTop = parseFloat(block.style.top);
        origHeight = block.offsetHeight;
        block.addClass("is-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    }
  }

  private getTaskDuration(task: Task): number {
    if (!task.scheduledTime) return DEFAULT_DURATION;
    const s = task.scheduledTime.start;
    const e = task.scheduledTime.end;
    if (!e) return DEFAULT_DURATION;
    return (e.hour * 60 + e.minute) - (s.hour * 60 + s.minute);
  }

  private findTask(taskId: string): Task | undefined {
    return getAllTasks(this.daily).find((t) => t.id === taskId);
  }

  private async writeChange(
    modify: (content: string) => string
  ): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
    }

    this.writeTimeout = setTimeout(async () => {
      const content = await this.app.vault.read(this.file);
      const newContent = modify(content);
      if (newContent !== content) {
        this.suppressNextModify = true;
        await this.app.vault.modify(this.file, newContent);
        const newDaily = parseDaily(newContent, this.file.path);
        this.daily = newDaily;
        this.onRefresh();
      }
    }, 150);
  }
}
