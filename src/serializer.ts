import { TimeRange } from "./types";

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

export function removeSchedule(
  content: string,
  lineNum: number,
  slotIndex: number = 0
): string {
  const lines = content.split("\n");
  const line = lines[lineNum];
  if (!line) return content;

  let matchIdx = 0;
  lines[lineNum] = line.replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, (match) => {
    return matchIdx++ === slotIndex ? "" : match;
  });
  lines[lineNum] = lines[lineNum].replace(/  +/g, " ").trimEnd();
  return lines.join("\n");
}

export function updateSchedule(
  content: string,
  lineNum: number,
  time: TimeRange,
  slotIndex: number = 0
): string {
  const lines = content.split("\n");
  const line = lines[lineNum];
  if (!line) return content;

  const annotation = formatTimeRange(time);
  let matchIdx = 0;
  lines[lineNum] = line.replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, (match) => {
    return matchIdx++ === slotIndex ? annotation : match;
  });
  return lines.join("\n");
}
