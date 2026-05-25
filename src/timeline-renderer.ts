import { Task, DailyNote, TimeRange } from "./types";
import { getDisplayText, getScheduledTasks, getUnscheduledTasks } from "./parser";

export const HOUR_HEIGHT = 60;
export const DAY_START = 7;
export const DAY_END = 23;
export const SNAP_MINUTES = 15;
export const DEFAULT_DURATION = 60;

const SECTION_COLORS: Record<string, string> = {
  Highlight: "var(--interactive-accent)",
  "Key Tasks": "var(--text-accent)",
  "Admin / Optional": "var(--text-muted)",
};

function timeToY(hour: number, minute: number): number {
  return (hour - DAY_START) * HOUR_HEIGHT + (minute / 60) * HOUR_HEIGHT;
}

function durationToHeight(start: TimeRange["start"], end: TimeRange["start"]): number {
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  return ((endMin - startMin) / 60) * HOUR_HEIGHT;
}

export function snapToGrid(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

export function yToTime(y: number): { hour: number; minute: number } {
  const totalMinutes = (y / HOUR_HEIGHT) * 60 + DAY_START * 60;
  const snapped = snapToGrid(totalMinutes);
  return { hour: Math.floor(snapped / 60), minute: snapped % 60 };
}

export interface RenderedElements {
  container: HTMLElement;
  pool: HTMLElement;
  grid: HTMLElement;
  slotsContainer: HTMLElement;
  nowLine: HTMLElement;
  taskBlocks: Map<string, HTMLElement>;
  poolItems: Map<string, HTMLElement>;
}

export function renderTimeline(
  parentEl: HTMLElement,
  daily: DailyNote | null
): RenderedElements {
  parentEl.empty();

  const container = parentEl.createDiv({ cls: "day-timeline-container" });

  const header = container.createDiv({ cls: "day-timeline-header" });
  if (daily) {
    const d = new Date(daily.date + "T00:00:00");
    const fmt = d.toLocaleDateString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    header.createSpan({ text: fmt, cls: "day-timeline-date" });
  } else {
    header.createSpan({ text: "Open a daily note", cls: "day-timeline-date" });
  }

  const pool = container.createDiv({ cls: "day-timeline-pool" });
  const poolItems = new Map<string, HTMLElement>();

  if (daily) {
    const unscheduled = getUnscheduledTasks(daily);
    const poolHeader = pool.createDiv({ cls: "day-timeline-pool-header" });
    poolHeader.createSpan({ text: `Unscheduled (${unscheduled.length})` });

    for (const task of unscheduled) {
      const item = pool.createDiv({ cls: "day-timeline-pool-item" });
      item.setAttribute("draggable", "true");
      item.dataset.taskId = task.id;
      item.dataset.lineStart = String(task.lineStart);

      const checkbox = item.createSpan({ cls: "pool-item-checkbox" });
      checkbox.setText(task.checked ? "[x]" : "[ ]");

      const textEl = item.createSpan({ cls: "pool-item-text" });
      textEl.setText(truncate(getDisplayText(task), 60));

      if (task.tags.length > 0) {
        const tagsEl = item.createSpan({ cls: "pool-item-tags" });
        tagsEl.setText(task.tags.slice(0, 3).join(" "));
      }

      const color = SECTION_COLORS[task.section] ?? "var(--text-normal)";
      item.style.borderLeftColor = color;

      if (task.checked) item.addClass("is-completed");

      poolItems.set(task.id, item);
    }
  }

  const gridWrapper = container.createDiv({ cls: "day-timeline-grid" });
  const hoursCol = gridWrapper.createDiv({ cls: "day-timeline-hours" });
  const slotsContainer = gridWrapper.createDiv({ cls: "day-timeline-slots" });

  for (let h = DAY_START; h <= DAY_END; h++) {
    const label = hoursCol.createDiv({ cls: "hour-label" });
    label.setText(`${String(h).padStart(2, "0")}:00`);
    label.style.height = `${HOUR_HEIGHT}px`;

    const slot = slotsContainer.createDiv({ cls: "hour-slot" });
    slot.style.height = `${HOUR_HEIGHT}px`;
    slot.dataset.hour = String(h);
  }

  const grid = slotsContainer;
  const taskBlocks = new Map<string, HTMLElement>();

  if (daily) {
    const scheduled = getScheduledTasks(daily);
    for (const task of scheduled) {
      const tr = task.scheduledTime!;
      const end = tr.end ?? { hour: tr.start.hour + 1, minute: tr.start.minute };
      const top = timeToY(tr.start.hour, tr.start.minute);
      const height = durationToHeight(tr.start, end);

      const block = slotsContainer.createDiv({ cls: "task-block" });
      block.setAttribute("draggable", "false");
      block.dataset.taskId = task.id;
      block.dataset.lineStart = String(task.lineStart);

      block.style.top = `${top}px`;
      block.style.height = `${Math.max(height, SNAP_MINUTES)}px`;

      const color = SECTION_COLORS[task.section] ?? "var(--text-accent)";
      block.style.backgroundColor = color;

      const resizeTop = block.createDiv({ cls: "task-block-resize-top" });

      const handle = block.createDiv({ cls: "task-block-handle" });
      handle.createSpan({ cls: "task-block-text", text: truncate(getDisplayText(task), 40) });

      const timeLabel = block.createDiv({ cls: "task-block-time" });
      const startStr = `${String(tr.start.hour).padStart(2, "0")}:${String(tr.start.minute).padStart(2, "0")}`;
      const endStr = `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`;
      timeLabel.setText(`${startStr} – ${endStr}`);

      const resizeHandle = block.createDiv({ cls: "task-block-resize" });

      if (task.checked) block.addClass("is-completed");

      taskBlocks.set(task.id, block);
    }
  }

  const nowLine = slotsContainer.createDiv({ cls: "now-line" });
  updateNowLine(nowLine);

  return { container, pool, grid, slotsContainer, nowLine, taskBlocks, poolItems };
}

export function updateNowLine(nowLine: HTMLElement): void {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  if (h < DAY_START || h > DAY_END) {
    nowLine.style.display = "none";
    return;
  }

  nowLine.style.display = "block";
  nowLine.style.top = `${timeToY(h, m)}px`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
