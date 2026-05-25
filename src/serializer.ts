import { TimeRange } from "./types";

const SCHEDULED_RE = /@(\d{2}:\d{2})-(\d{2}:\d{2})/;
const TAG_RE = /#[\w-]+/;

function formatTime(t: { hour: number; minute: number }): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

function formatTimeRange(tr: TimeRange): string {
  const end = tr.end ?? tr.start;
  return `@${formatTime(tr.start)}-${formatTime(end)}`;
}

export function addSchedule(
  content: string,
  lineNum: number,
  time: TimeRange
): string {
  const lines = content.split("\n");
  const line = lines[lineNum];
  if (!line) return content;

  const annotation = formatTimeRange(time);

  const tagIndex = line.search(TAG_RE);
  if (tagIndex !== -1) {
    lines[lineNum] =
      line.slice(0, tagIndex) + annotation + " " + line.slice(tagIndex);
  } else {
    lines[lineNum] = line.trimEnd() + " " + annotation;
  }

  return lines.join("\n");
}

export function removeSchedule(content: string, lineNum: number): string {
  const lines = content.split("\n");
  const line = lines[lineNum];
  if (!line) return content;

  lines[lineNum] = line.replace(SCHEDULED_RE, "").replace(/  +/g, " ").trimEnd();
  return lines.join("\n");
}

export function updateSchedule(
  content: string,
  lineNum: number,
  time: TimeRange
): string {
  const lines = content.split("\n");
  const line = lines[lineNum];
  if (!line) return content;

  const annotation = formatTimeRange(time);

  if (SCHEDULED_RE.test(line)) {
    lines[lineNum] = line.replace(SCHEDULED_RE, annotation);
  }

  return lines.join("\n");
}
