import { DailyNote, Section, Task, TimeRange } from "./types";

const SECTION_RE = /^##\s+(Highlight|Key Tasks|Admin\s*\/?\s*Optional)/;
const STOP_SECTION_RE = /^##\s+Notes/;
const TASK_RE = /^- \[([ x])\]\s+(.+)$/;
const SUBTASK_RE = /^\t+- \[([ x])\]\s+(.+)$/;

function parseTime(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(":").map(Number);
  return { hour: h, minute: m };
}

function parseScheduledTimes(line: string): TimeRange[] {
  const times: TimeRange[] = [];
  const re = /@(\d{2}:\d{2})-(\d{2}:\d{2})/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    times.push({ start: parseTime(m[1]), end: parseTime(m[2]) });
  }
  return times;
}

export function parseDaily(content: string, filePath: string): DailyNote {
  const allLines = content.split("\n");
  const date = filePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let stopped = false;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];

    if (stopped) continue;

    if (STOP_SECTION_RE.test(line)) {
      stopped = true;
      continue;
    }

    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      currentSection = {
        heading: sectionMatch[1],
        headingLine: i,
        tasks: [],
      };
      sections.push(currentSection);
      continue;
    }

    if (!currentSection) continue;

    const taskMatch = line.match(TASK_RE);
    if (taskMatch) {
      const rawLines = [line];
      const subtaskLines: string[] = [];
      let lineEnd = i;

      let j = i + 1;
      while (j < allLines.length && SUBTASK_RE.test(allLines[j])) {
        rawLines.push(allLines[j]);
        subtaskLines.push(allLines[j]);
        lineEnd = j;
        j++;
      }

      const task: Task = {
        id: `${currentSection.heading}-${currentSection.tasks.length}`,
        text: taskMatch[2],
        checked: taskMatch[1] === "x",
        scheduledTimes: parseScheduledTimes(line),
        tags: extractTags(taskMatch[2]),
        subtaskLines,
        lineStart: i,
        lineEnd,
        rawLines,
        section: currentSection.heading,
      };

      currentSection.tasks.push(task);
      i = lineEnd;
    }
  }

  return { filePath, date, sections, allLines };
}

function extractTags(text: string): string[] {
  const matches = text.match(/#[\w-]+/g);
  return matches ?? [];
}

export function getDisplayText(task: Task): string {
  let text = task.text;
  text = text.replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, "").trim();
  text = text.replace(/#[\w-]+/g, "").trim();
  text = text.replace(
    /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}\s+\d{2}:\d{2}[-–].*/,
    ""
  ).trim();
  text = text.replace(/\*\*/g, "");
  return text;
}

export function getAllTasks(daily: DailyNote): Task[] {
  return daily.sections.flatMap((s) => s.tasks);
}

export function getScheduledTasks(daily: DailyNote): Task[] {
  return getAllTasks(daily).filter((t) => t.scheduledTimes.length > 0);
}

export function getUnscheduledTasks(daily: DailyNote): Task[] {
  return getAllTasks(daily).filter((t) => t.scheduledTimes.length === 0);
}
