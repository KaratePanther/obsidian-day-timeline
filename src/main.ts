// @ts-nocheck
import { Plugin, ItemView, MarkdownView, Menu, TFile, setIcon } from "obsidian";
import { ViewPlugin, WidgetType, Decoration, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════
const VIEW_TYPE        = "day-timeline";
const PX_PER_HOUR      = 60;
const START_HOUR       = 7;
const END_HOUR         = 23;
const SNAP_MIN         = 15;
const DEFAULT_SLOT_MIN = 60;
const SECTION_COLORS   = {
  "Highlight"       : "var(--interactive-accent)",
  "Key Tasks"       : "var(--text-accent)",
  "Admin / Optional": "var(--text-muted)",
};

// ═══════════════════════════════════════════════════════════════════
// Time utilities
// ═══════════════════════════════════════════════════════════════════
function parseTime(str) {
  const [h, m] = str.split(":").map(Number);
  return { hour: h, minute: m };
}
function formatTime(t) {
  return `${String(t.hour).padStart(2,"0")}:${String(t.minute).padStart(2,"0")}`;
}
function t2px(hour, minute) {
  return (hour - START_HOUR) * PX_PER_HOUR + (minute / 60) * PX_PER_HOUR;
}
function dur2px(start, end) {
  return ((end.hour * 60 + end.minute - start.hour * 60 - start.minute) / 60) * PX_PER_HOUR;
}
function snap(mins) { return Math.round(mins / SNAP_MIN) * SNAP_MIN; }
function px2time(px) {
  const total = snap((px / PX_PER_HOUR) * 60 + START_HOUR * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}
function extractTimes(text) {
  const re = /@(\d{2}:\d{2})-(\d{2}:\d{2})/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null)
    out.push({ start: parseTime(m[1]), end: parseTime(m[2]) });
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════
const RE_SECTION  = /^##\s+(Highlight|Key Tasks|Admin\s*\/?\s*Optional)/;
const RE_SCHEDULE = /^##\s+Schedule\s*$/;
const RE_NOTES    = /^##\s+Notes/;
const RE_TASK     = /^- \[([ x])\]\s+(.+)$/;
const RE_SUB      = /^\t+- \[([ x])\]\s+(.+)$/;
const RE_BLOCK    = /^-\s+(?!\[)(.+)$/;   // plain bullet, no checkbox

function parseDailyNote(content, path) {
  const lines    = content.split("\n");
  const date     = (path.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  const sections = [];
  const scheduleBlocks = [];   // plain-bullet items from ## Schedule
  let cur = null, inNotes = false, inSchedule = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inNotes) continue;
    if (RE_NOTES.test(line)) { inNotes = true; inSchedule = false; cur = null; continue; }

    if (RE_SCHEDULE.test(line)) { inSchedule = true; cur = null; continue; }

    const sec = line.match(RE_SECTION);
    if (sec) {
      inSchedule = false;
      cur = { heading: sec[1], tasks: [] };
      sections.push(cur);
      continue;
    }

    // Any other ## heading ends both schedule and task sections
    if (/^##\s+/.test(line)) { inSchedule = false; cur = null; continue; }

    // ── Schedule block items ──────────────────────────────────────
    if (inSchedule) {
      const bm = line.match(RE_BLOCK);
      if (bm) {
        const raw   = bm[1];
        const times = extractTimes(raw);
        const label = raw.replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g,"").trim();
        scheduleBlocks.push({
          id            : `sched-${i}`,
          label,
          scheduledTimes: times,
          lineStart     : i,
        });
      }
      continue;
    }

    // ── Task items ────────────────────────────────────────────────
    if (!cur) continue;
    const task = line.match(RE_TASK);
    if (task) {
      const rawLines = [line], subtaskLines = [];
      let end = i, j = i + 1;
      while (j < lines.length && RE_SUB.test(lines[j])) {
        rawLines.push(lines[j]); subtaskLines.push(lines[j]); end = j; j++;
      }
      cur.tasks.push({
        id            : `${cur.heading}-${cur.tasks.length}`,
        text          : task[2],
        checked       : task[1] === "x",
        scheduledTimes: extractTimes(line),
        tags          : task[2].match(/#[\w-]+/g) || [],
        subtaskLines, lineStart: i, lineEnd: end, rawLines,
        section       : cur.heading,
      });
      i = end;
    }
  }
  return { filePath: path, date, sections, allLines: lines, scheduleBlocks };
}

function cleanText(task) {
  return task.text
    .replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, "")
    .replace(/#[\w-]+/g, "")
    .replace(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}\s+\d{2}:\d{2}[-–].*/,"")
    .replace(/\*\*/g, "").trim();
}

function allTasks(d)    { return d.sections.flatMap(s => s.tasks); }
function scheduled(d)   { return allTasks(d).filter(t => t.scheduledTimes.length > 0); }
function unscheduled(d) { return allTasks(d).filter(t => t.scheduledTimes.length === 0); }
function trunc(s, n)    { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

// ═══════════════════════════════════════════════════════════════════
// File write helpers
// ═══════════════════════════════════════════════════════════════════
function addTime(content, lineIdx, slot) {
  const lines = content.split("\n");
  if (!lines[lineIdx]) return content;
  const ann    = `@${formatTime(slot.start)}-${formatTime(slot.end)}`;
  const tagPos = lines[lineIdx].search(/#[\w-]+/);
  lines[lineIdx] = tagPos !== -1
    ? lines[lineIdx].slice(0, tagPos) + ann + " " + lines[lineIdx].slice(tagPos)
    : lines[lineIdx].trimEnd() + " " + ann;
  return lines.join("\n");
}

function removeTime(content, lineIdx, si = 0) {
  const lines = content.split("\n");
  if (!lines[lineIdx]) return content;
  let i = 0;
  lines[lineIdx] = lines[lineIdx]
    .replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, m => i++ === si ? "" : m)
    .replace(/  +/g, " ").trimEnd();
  return lines.join("\n");
}

function updateTime(content, lineIdx, slot, si = 0) {
  const lines = content.split("\n");
  if (!lines[lineIdx]) return content;
  const ann = `@${formatTime(slot.start)}-${formatTime(slot.end)}`;
  let i = 0;
  lines[lineIdx] = lines[lineIdx].replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, m => i++ === si ? ann : m);
  return lines.join("\n");
}

// Append a new schedule block line (with time) to ## Schedule section
function appendScheduleBlock(content, label, slot) {
  const lines = content.split("\n");
  const ann   = `@${formatTime(slot.start)}-${formatTime(slot.end)}`;
  const entry = `- ${label} ${ann}`;

  // Find ## Schedule
  let schedIdx = lines.findIndex(l => RE_SCHEDULE.test(l));
  if (schedIdx === -1) {
    // No section yet — insert before ## Notes (or append)
    const notesIdx = lines.findIndex(l => RE_NOTES.test(l));
    if (notesIdx !== -1) {
      lines.splice(notesIdx, 0, "## Schedule", entry, "");
    } else {
      lines.push("## Schedule", entry, "");
    }
    return lines.join("\n");
  }

  // Find end of Schedule section
  let insertAt = schedIdx + 1;
  while (insertAt < lines.length && !lines[insertAt].startsWith("## ")) {
    insertAt++;
  }
  lines.splice(insertAt, 0, entry);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Timer — module-level so it survives re-renders
// ═══════════════════════════════════════════════════════════════════
const timer = {
  duration : (parseInt(localStorage.getItem("day-timeline-timer-min") || "25")) * 60,
  remaining: null,
  running  : false,
  iv       : null,
  timeEl   : null,
  btnEl    : null,
};
timer.remaining = timer.duration;

function fmtTimer(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function syncTimerDisplay() {
  if (timer.timeEl) timer.timeEl.setText(fmtTimer(timer.remaining ?? timer.duration));
  if (timer.btnEl)  timer.btnEl.setText(timer.running ? "⏸" : "▶");
}
function timerTick() {
  timer.remaining--;
  syncTimerDisplay();
  if (timer.remaining <= 0) {
    timer.running = false;
    clearInterval(timer.iv); timer.iv = null;
    timer.remaining = 0;
    syncTimerDisplay();
    playChime();
    showExercise(true);
  }
}
function startTimer() {
  if (timer.running) return;
  if (timer.remaining <= 0) timer.remaining = timer.duration;
  timer.running = true;
  timer.iv = setInterval(timerTick, 1000);
  syncTimerDisplay();
}
function pauseTimer() {
  timer.running = false;
  if (timer.iv) { clearInterval(timer.iv); timer.iv = null; }
  syncTimerDisplay();
}
function resetTimer() {
  pauseTimer();
  timer.remaining = timer.duration;
  syncTimerDisplay();
}
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[523,0],[659,0.18],[784,0.36]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      const t0 = ctx.currentTime + delay;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      osc.start(t0); osc.stop(t0 + 0.5);
    });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════
// Exercise pause suggestions — module-level so they survive re-renders
// ═══════════════════════════════════════════════════════════════════
const EXERCISES = [
  "10 push-ups",
  "10 squats",
  "10 lunges (each leg 5)",
  "30 jumping jacks",
  "15 calf raises",
  "20 mountain climbers",
  "20s plank",
  "15 glute bridges",
  "30 air punches marching",
  "30 leg bouncing jacks",
  "10 jump squats",
  "20s mountain pose",
  "10 leg swings (each leg 5)",
  "10 side leg swings (each leg 5)",
  "10 knee-to-elbows",
  "10 table dips",
  "20 arm rotations",
  "10 cat-cows",
  "10 side bends",
  "20 high knees",
  "20 butt kicks",
  "10 front kicks",
  "10 side kicks",
  "10 reverse lunges",
  "20 bouncing overhead punches",
  "20 boxer shuffles",
  "20 lateral steps",
  "20 elbow-to-knee crunches",
  "20 toe taps",
  "20 standing cross punches",
  "20 standing knee drives",
  "20 skater taps",
  "20 step jacks",
  "20 power marches",
  "20 squat pulses",
  "20 alternating side reaches",
  "20 fast feet",
  "20 standing twists",
  "20 side-to-side punches",
  "20 wall push-offs",
  "20 chest openers",
  "20 running man shuffles",
  "20 ghost jump rope",
];
const exercise = { current: null, visible: false, slotEl: null, textEl: null };

function pickExercise() {
  return EXERCISES[Math.floor(Math.random() * EXERCISES.length)];
}
function syncExerciseDisplay() {
  if (!exercise.slotEl) return;
  exercise.slotEl.style.display = exercise.visible ? "flex" : "none";
  if (exercise.textEl)
    exercise.textEl.setText(exercise.current ? `Try: ${exercise.current}` : "");
}
function showExercise(fresh) {
  if (fresh || !exercise.current) exercise.current = pickExercise();
  exercise.visible = true;
  syncExerciseDisplay();
}
function toggleExercise() {
  if (exercise.visible) { exercise.visible = false; syncExerciseDisplay(); }
  else showExercise(true);
}

// ═══════════════════════════════════════════════════════════════════
// Custom block-name prompt (inline overlay)
// ═══════════════════════════════════════════════════════════════════
function promptBlockName(onConfirm) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)";
  const box = document.createElement("div");
  box.style.cssText = "background:var(--background-primary);padding:16px;border-radius:8px;display:flex;flex-direction:column;gap:10px;min-width:240px;box-shadow:0 4px 20px rgba(0,0,0,.4)";
  const lbl = document.createElement("div");
  lbl.style.cssText = "font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px";
  lbl.textContent = "Block name";
  const inp = document.createElement("input");
  inp.type = "text"; inp.placeholder = "e.g. Deep work…";
  inp.style.cssText = "background:var(--background-modifier-form-field);border:1px solid var(--background-modifier-border);border-radius:4px;padding:6px 8px;color:var(--text-normal);font-size:13px;outline:none;width:100%;box-sizing:border-box";
  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.style.cssText = "padding:4px 12px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-modifier-hover);cursor:pointer;font-size:12px;color:var(--text-normal)";
  const ok = document.createElement("button");
  ok.textContent = "Add";
  ok.style.cssText = "padding:4px 12px;border-radius:4px;border:none;background:var(--interactive-accent);color:var(--text-on-accent);cursor:pointer;font-size:12px;font-weight:500";
  btns.appendChild(cancel); btns.appendChild(ok);
  box.appendChild(lbl); box.appendChild(inp); box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  inp.focus();
  const close  = () => overlay.remove();
  const submit = () => { const v = inp.value.trim(); if (v) onConfirm(v); close(); };
  cancel.addEventListener("click", close);
  ok.addEventListener("click", submit);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); submit(); }
    if (e.key === "Escape") close();
  });
}

// ═══════════════════════════════════════════════════════════════════
// Render
// ═══════════════════════════════════════════════════════════════════
function render(container, daily) {
  container.empty();
  const root = container.createDiv({ cls: "day-timeline-container" });

  // ── Header ──────────────────────────────────────────────────────
  const hdr = root.createDiv({ cls: "day-timeline-header" });
  if (daily) {
    const label = new Date(daily.date + "T00:00:00").toLocaleDateString("en-US",
      { weekday:"short", day:"numeric", month:"short", year:"numeric" });
    hdr.createSpan({ text: label, cls: "day-timeline-date" });
  } else {
    hdr.createSpan({ text: "Open a daily note", cls: "day-timeline-date" });
  }

  // ── Timer ────────────────────────────────────────────────────────
  const timerEl = hdr.createDiv({ cls: "day-timeline-timer" });
  const timeText = timerEl.createSpan({ cls: "timer-time" });
  timer.timeEl = timeText;
  syncTimerDisplay();

  timeText.addEventListener("click", () => {
    if (timer.running) return;
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "1"; inp.max = "180";
    inp.value = String(Math.round(timer.duration / 60));
    inp.className = "timer-input";
    timeText.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => {
      const v = Math.max(1, Math.min(180, parseInt(inp.value) || 25));
      timer.duration = v * 60;
      timer.remaining = timer.duration;
      localStorage.setItem("day-timeline-timer-min", String(v));
      inp.replaceWith(timeText);
      syncTimerDisplay();
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); commit(); }
    });
  });

  const playBtn = timerEl.createSpan({ cls: "timer-btn" });
  timer.btnEl = playBtn;
  syncTimerDisplay();
  playBtn.addEventListener("click", () => timer.running ? pauseTimer() : startTimer());

  const resetBtn = timerEl.createSpan({ cls: "timer-reset", text: "↺" });
  resetBtn.title = "Reset timer";
  resetBtn.addEventListener("click", resetTimer);

  const exSummon = timerEl.createSpan({ cls: "timer-exercise" });
  setIcon(exSummon, "dumbbell");
  exSummon.setAttribute("aria-label", "Exercise suggestion");
  exSummon.title = "Exercise suggestion";
  exSummon.addEventListener("click", () => toggleExercise());

  // ── Exercise suggestion (movement break) ─────────────────────────
  const exSlot = root.createDiv({ cls: "day-timeline-exercise" });
  exercise.slotEl = exSlot;
  exercise.textEl = exSlot.createSpan({ cls: "exercise-text" });
  const exReroll = exSlot.createSpan({ cls: "exercise-reroll" });
  setIcon(exReroll, "rotate-cw");
  exReroll.setAttribute("aria-label", "Another exercise");
  exReroll.title = "Another exercise";
  exReroll.addEventListener("click", () => showExercise(true));
  syncExerciseDisplay();

  // ── Pool ─────────────────────────────────────────────────────────
  const pool = root.createDiv({ cls: "day-timeline-pool" });
  const savedH = parseInt(localStorage.getItem("day-timeline-pool-height") || "200");
  pool.style.maxHeight = savedH + "px";
  pool.style.minHeight = "60px";

  const poolItems     = new Map();   // taskId → el
  const schedPoolItems = new Map();  // scheduleBlock id → el

  if (daily) {
    const schedUnscheduled = daily.scheduleBlocks.filter(b => b.scheduledTimes.length === 0);
    const taskUnscheduled  = unscheduled(daily);

    // Schedule block group
    if (schedUnscheduled.length > 0) {
      pool.createDiv({ cls: "day-timeline-pool-header" })
        .createSpan({ text: `Schedule (${schedUnscheduled.length})` });
      for (const blk of schedUnscheduled) {
        const item = pool.createDiv({ cls: "day-timeline-pool-item is-schedule-item" });
        item.setAttribute("draggable", "true");
        item.dataset.schedId   = blk.id;
        item.dataset.lineStart = String(blk.lineStart);
        item.createSpan({ cls: "pool-item-schedule-dot", text: "·" });
        item.createSpan({ cls: "pool-item-text",         text: trunc(blk.label, 60) });
        schedPoolItems.set(blk.id, item);
      }
      if (taskUnscheduled.length > 0)
        pool.createDiv({ cls: "day-timeline-pool-divider" });
    }

    // Task group
    if (taskUnscheduled.length > 0) {
      pool.createDiv({ cls: "day-timeline-pool-header" })
        .createSpan({ text: `Unscheduled (${taskUnscheduled.length})` });
      for (const task of taskUnscheduled) {
        const item = pool.createDiv({ cls: "day-timeline-pool-item" });
        item.setAttribute("draggable", "true");
        item.dataset.taskId    = task.id;
        item.dataset.lineStart = String(task.lineStart);
        item.style.borderLeftColor = SECTION_COLORS[task.section] || "var(--text-accent)";
        if (task.checked) item.addClass("is-completed");
        item.createSpan({ cls: "pool-item-checkbox", text: task.checked ? "[x]" : "[ ]" });
        item.createSpan({ cls: "pool-item-text",     text: trunc(cleanText(task), 60) });
        if (task.tags.length > 0)
          item.createSpan({ cls: "pool-item-tags", text: task.tags.slice(0, 3).join(" ") });
        poolItems.set(task.id, item);
      }
    }
  }

  // ── Pool resize handle ───────────────────────────────────────────
  const rh = root.createDiv({ cls: "day-timeline-pool-resize" });
  rh.createDiv({ cls: "day-timeline-pool-resize-grip" });
  setupPoolResize(rh, pool);

  // ── Grid ─────────────────────────────────────────────────────────
  const grid    = root.createDiv({ cls: "day-timeline-grid" });
  const hoursEl = grid.createDiv({ cls: "day-timeline-hours" });
  const slots   = grid.createDiv({ cls: "day-timeline-slots" });

  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const lbl = hoursEl.createDiv({ cls: "hour-label" });
    lbl.setText(`${String(h).padStart(2,"0")}:00`);
    lbl.style.height = PX_PER_HOUR + "px";
    const slot = slots.createDiv({ cls: "hour-slot" });
    slot.style.height = PX_PER_HOUR + "px";
    slot.dataset.hour = String(h);
  }

  // ── Task blocks on timeline ──────────────────────────────────────
  const taskBlocks = new Map();
  if (daily) {
    for (const task of scheduled(daily)) {
      for (let si = 0; si < task.scheduledTimes.length; si++) {
        const st  = task.scheduledTimes[si];
        const end = st.end || { hour: st.start.hour + 1, minute: st.start.minute };
        const blk = slots.createDiv({ cls: "task-block" });
        blk.setAttribute("draggable", "false");
        blk.dataset.taskId    = task.id;
        blk.dataset.slotIndex = String(si);
        blk.dataset.lineStart = String(task.lineStart);
        blk.style.top             = `${t2px(st.start.hour, st.start.minute)}px`;
        blk.style.height          = `${Math.max(dur2px(st.start, end), SNAP_MIN)}px`;
        blk.style.backgroundColor = SECTION_COLORS[task.section] || "var(--text-accent)";
        blk.createDiv({ cls: "task-block-resize-top" });
        const handle = blk.createDiv({ cls: "task-block-handle" });
        handle.createSpan({
          cls: "task-block-text",
          text: task.scheduledTimes.length > 1
            ? `${trunc(cleanText(task), 35)} (${si+1}/${task.scheduledTimes.length})`
            : trunc(cleanText(task), 40),
        });
        blk.createDiv({ cls: "task-block-resize" });
        if (task.checked) blk.addClass("is-completed");
        taskBlocks.set(`${task.id}:${si}`, blk);
      }
    }
  }

  // ── Schedule blocks on timeline ──────────────────────────────────
  const schedBlocks = new Map();  // `schedId:si` → el
  if (daily) {
    for (const sb of daily.scheduleBlocks) {
      for (let si = 0; si < sb.scheduledTimes.length; si++) {
        const st  = sb.scheduledTimes[si];
        const end = st.end || { hour: st.start.hour + 1, minute: st.start.minute };
        const blk = slots.createDiv({ cls: "task-block time-block" });
        blk.setAttribute("draggable", "false");
        blk.dataset.schedId   = sb.id;
        blk.dataset.slotIndex = String(si);
        blk.dataset.lineStart = String(sb.lineStart);
        blk.style.top    = `${t2px(st.start.hour, st.start.minute)}px`;
        blk.style.height = `${Math.max(dur2px(st.start, end), SNAP_MIN)}px`;
        blk.createDiv({ cls: "task-block-resize-top" });
        blk.createDiv({ cls: "task-block-handle" })
          .createSpan({ cls: "task-block-text", text: trunc(sb.label, 40) });
        blk.createDiv({ cls: "task-block-resize" });
        schedBlocks.set(`${sb.id}:${si}`, blk);
      }
    }
  }

  // Now line
  const nowLine = slots.createDiv({ cls: "now-line" });
  updateNowLine(nowLine);

  return { root, pool, poolResizeHandle: rh, grid, slots, nowLine,
           taskBlocks, poolItems, schedBlocks, schedPoolItems };
}

function updateNowLine(el) {
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  if (h < START_HOUR || h > END_HOUR) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.style.top     = `${t2px(h, m)}px`;
}

// ═══════════════════════════════════════════════════════════════════
// Pool resize
// ═══════════════════════════════════════════════════════════════════
function setupPoolResize(handle, pool) {
  let startY = 0, startH = 0;
  const onMove = e => {
    const h = Math.max(60, Math.min(500, startH + e.clientY - startY));
    pool.style.maxHeight = h + "px";
    localStorage.setItem("day-timeline-pool-height", String(h));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup",   onUp);
    handle.removeClass("is-resizing");
  };
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    startY = e.clientY; startH = pool.offsetHeight;
    handle.addClass("is-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Drag & Drop Handler
// ═══════════════════════════════════════════════════════════════════
class DragHandler {
  constructor(app, file, daily, elements, onRefresh) {
    this.app        = app;
    this.file       = file;
    this.daily      = daily;
    this.el         = elements;
    this.onRefresh  = onRefresh;
    this.writeTimeout       = null;
    this.suppressNextModify = false;
    this.grabOffsetY        = 0;
    this.dragGhost          = null;
  }

  get shouldSuppressModify() {
    const v = this.suppressNextModify;
    this.suppressNextModify = false;
    return v;
  }

  setup() {
    this.setupPoolDrag();
    this.setupSchedPoolDrag();
    this.setupBlockDrag();
    this.setupSchedBlockDrag();
    this.setupResizeBottom();
    this.setupResizeTop();
    this.setupSchedResizes();
    this.setupGridDrop();
    this.setupPoolDrop();
    this.setupTaskContextMenu();
    this.setupSchedContextMenu();
    this.setupGridContextMenu();
    this.setupClickToNavigate();
  }

  // ── Ghost helper ────────────────────────────────────────────────
  createGhost(text, color, e, srcEl) {
    const g = document.createElement("div");
    g.className = "task-block";
    const w = this.el.slots.offsetWidth - 8;
    Object.assign(g.style, {
      position:"fixed", top:"-1000px", left:"-1000px",
      width:`${w}px`, height:"60px",
      background: color,
      borderRadius:"4px", padding:"4px 6px",
      boxShadow:"0 2px 8px rgba(0,0,0,.25)",
      zIndex:"9999", opacity:".85", pointerEvents:"none",
    });
    const span = document.createElement("span");
    span.className = "task-block-text";
    span.textContent = text.slice(0, 40);
    g.appendChild(span);
    document.body.appendChild(g);
    let ox = 4;
    if (srcEl) { const r = srcEl.getBoundingClientRect(); ox = Math.max(4, Math.min(e.clientX - r.left, w - 4)); }
    e.dataTransfer.setDragImage(g, ox, 0);
    this.dragGhost = g;
  }
  removeGhost() { this.dragGhost?.remove(); this.dragGhost = null; }

  // ── Task pool drag ───────────────────────────────────────────────
  setupPoolDrag() {
    for (const [id, el] of this.el.poolItems) {
      el.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.setData("application/day-timeline-pool", "1");
        this.grabOffsetY = 0;
        const task = this.findTask(id);
        if (task) this.createGhost(cleanText(task), SECTION_COLORS[task.section] || "var(--text-accent)", e, el);
        el.addClass("is-dragging");
      });
      el.addEventListener("dragend", () => { el.removeClass("is-dragging"); this.removeGhost(); });
    }
  }

  // ── Schedule pool drag ───────────────────────────────────────────
  setupSchedPoolDrag() {
    for (const [id, el] of this.el.schedPoolItems) {
      el.addEventListener("dragstart", e => {
        e.dataTransfer.setData("application/day-timeline-sched-pool", id);
        e.dataTransfer.setData("text/plain", "");
        this.grabOffsetY = 0;
        const blk = this.findSchedBlock(id);
        if (blk) this.createGhost(blk.label, "var(--background-modifier-border)", e, el);
        el.addClass("is-dragging");
      });
      el.addEventListener("dragend", () => { el.removeClass("is-dragging"); this.removeGhost(); });
    }
  }

  // ── Task block drag (timeline) ───────────────────────────────────
  setupBlockDrag() {
    for (const [key, blk] of this.el.taskBlocks) {
      const handle = blk.querySelector(".task-block-handle");
      if (!handle) continue;
      handle.addEventListener("mousedown", e => {
        blk.setAttribute("draggable", "true");
        this.grabOffsetY = e.clientY - blk.getBoundingClientRect().top;
      });
      blk.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", blk.dataset.taskId);
        e.dataTransfer.setData("application/day-timeline-block", "1");
        e.dataTransfer.setData("application/day-timeline-slot",  blk.dataset.slotIndex || "0");
        e.dataTransfer.setData("application/day-timeline-line",  blk.dataset.lineStart || "");
        blk.addClass("is-dragging");
      });
      blk.addEventListener("dragend", () => {
        blk.removeClass("is-dragging");
        blk.setAttribute("draggable", "false");
      });
    }
  }

  // ── Schedule block drag (timeline) ──────────────────────────────
  setupSchedBlockDrag() {
    for (const [key, blk] of this.el.schedBlocks) {
      const handle = blk.querySelector(".task-block-handle");
      if (!handle) continue;
      handle.addEventListener("mousedown", e => {
        blk.setAttribute("draggable", "true");
        this.grabOffsetY = e.clientY - blk.getBoundingClientRect().top;
      });
      blk.addEventListener("dragstart", e => {
        e.dataTransfer.setData("application/day-timeline-sched-block", blk.dataset.schedId);
        e.dataTransfer.setData("application/day-timeline-slot", blk.dataset.slotIndex || "0");
        e.dataTransfer.setData("application/day-timeline-line", blk.dataset.lineStart || "");
        e.dataTransfer.setData("text/plain", "");
        blk.addClass("is-dragging");
      });
      blk.addEventListener("dragend", () => {
        blk.removeClass("is-dragging");
        blk.setAttribute("draggable", "false");
      });
    }
  }

  // ── Grid drop (place on timeline) ───────────────────────────────
  setupGridDrop() {
    const { grid, slots } = this.el;
    grid.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      slots.addClass("drag-over");
    });
    grid.addEventListener("dragleave", e => {
      if (!(e.relatedTarget && grid.contains(e.relatedTarget)))
        slots.removeClass("drag-over");
    });
    grid.addEventListener("drop", async e => {
      e.preventDefault();
      slots.removeClass("drag-over");
      const types      = e.dataTransfer.types;
      const isPool     = types.includes("application/day-timeline-pool");
      const isBlock    = types.includes("application/day-timeline-block");
      const isEditor   = types.includes("application/day-timeline-editor");
      const isSchedP   = types.includes("application/day-timeline-sched-pool");
      const isSchedB   = types.includes("application/day-timeline-sched-block");

      const rect  = slots.getBoundingClientRect();
      const rawY  = e.clientY - rect.top - this.grabOffsetY;
      const start = px2time(Math.max(0, rawY));
      const endMin0 = start.hour * 60 + start.minute + DEFAULT_SLOT_MIN;
      const end   = { hour: Math.floor(endMin0 / 60), minute: endMin0 % 60 };

      // ── Schedule block from pool ──
      if (isSchedP) {
        const id  = e.dataTransfer.getData("application/day-timeline-sched-pool");
        const sb  = this.findSchedBlock(id);
        if (!sb) return;
        this.el.schedPoolItems.get(id)?.style && (this.el.schedPoolItems.get(id).style.display = "none");
        await this.write(c => addTime(c, sb.lineStart, { start, end }), true);
        return;
      }

      // ── Schedule block from timeline ──
      if (isSchedB) {
        const id = e.dataTransfer.getData("application/day-timeline-sched-block");
        const si = parseInt(e.dataTransfer.getData("application/day-timeline-slot") || "0");
        const sb = this.findSchedBlock(id);
        if (!sb || sb.scheduledTimes.length <= si) return;
        const dur    = this.getSchedDur(sb, si);
        const endMin = start.hour * 60 + start.minute + dur;
        const slot   = { start, end: { hour: Math.floor(endMin/60), minute: endMin%60 } };
        const blk    = this.el.schedBlocks.get(`${id}:${si}`);
        if (blk) blk.style.top = `${t2px(start.hour, start.minute)}px`;
        await this.write(c => updateTime(c, sb.lineStart, slot, si), true);
        return;
      }

      if (!this.daily) return;

      // ── Task from pool or editor ──
      let task;
      if (isEditor) {
        const data = JSON.parse(e.dataTransfer.getData("application/day-timeline-editor"));
        task = allTasks(this.daily).find(t => t.lineStart === data.lineStart);
        if (!task) {
          // Could be a schedule block line dragged from the editor
          const sb = this.daily.scheduleBlocks.find(b => b.lineStart === data.lineStart);
          if (sb) {
            const poolEl = this.el.schedPoolItems.get(sb.id);
            if (poolEl) poolEl.style.display = "none";
            await this.write(c => addTime(c, sb.lineStart, { start, end }), true);
            return;
          }
        }
      } else if (isPool) {
        const id = e.dataTransfer.getData("text/plain");
        if (!id) return;
        task = this.findTask(id);
      }
      if (task && (isPool || isEditor)) {
        this.el.poolItems.get(task.id)?.style && (this.el.poolItems.get(task.id).style.display = "none");
        await this.write(c => addTime(c, task.lineStart, { start, end }), true);
        return;
      }

      // ── Task block from timeline ──
      if (isBlock) {
        const id   = e.dataTransfer.getData("text/plain");
        const si   = parseInt(e.dataTransfer.getData("application/day-timeline-slot") || "0");
        if (!id) return;
        task = this.findTask(id);
        if (!task) return;
        const dur    = this.getSlotDur(task, si);
        const endMin = start.hour * 60 + start.minute + dur;
        const slot   = { start, end: { hour: Math.floor(endMin/60), minute: endMin%60 } };
        const blk    = this.el.taskBlocks.get(`${id}:${si}`);
        if (blk) blk.style.top = `${t2px(start.hour, start.minute)}px`;
        await this.write(c => updateTime(c, task.lineStart, slot, si), true);
      }
    });
  }

  // ── Pool drop (remove from timeline) ────────────────────────────
  setupPoolDrop() {
    const { pool } = this.el;
    pool.addEventListener("dragover", e => {
      if (e.dataTransfer.types.includes("application/day-timeline-block") ||
          e.dataTransfer.types.includes("application/day-timeline-sched-block")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        pool.addClass("drag-over");
      }
    });
    pool.addEventListener("dragleave", () => pool.removeClass("drag-over"));
    pool.addEventListener("drop", async e => {
      e.preventDefault();
      pool.removeClass("drag-over");

      // Schedule block → remove time annotation
      if (e.dataTransfer.types.includes("application/day-timeline-sched-block")) {
        const id = e.dataTransfer.getData("application/day-timeline-sched-block");
        const si = parseInt(e.dataTransfer.getData("application/day-timeline-slot") || "0");
        const sb = this.findSchedBlock(id);
        if (!sb || sb.scheduledTimes.length === 0) return;
        const blk = this.el.schedBlocks.get(`${id}:${si}`);
        if (blk) blk.style.display = "none";
        await this.write(c => removeTime(c, sb.lineStart, si), true);
        return;
      }

      // Task block → remove time annotation
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const si   = parseInt(e.dataTransfer.getData("application/day-timeline-slot") || "0");
      const task = this.findTask(id);
      if (!task || task.scheduledTimes.length === 0) return;
      const blk = this.el.taskBlocks.get(`${id}:${si}`);
      if (blk) blk.style.display = "none";
      await this.write(c => removeTime(c, task.lineStart, si), true);
    });
  }

  // ── Task block resize (bottom) ───────────────────────────────────
  setupResizeBottom() {
    for (const [key, blk] of this.el.taskBlocks) {
      const rz = blk.querySelector(".task-block-resize");
      if (!rz) continue;
      const si = parseInt(blk.dataset.slotIndex || "0");
      let startY = 0, startH = 0;
      const onMove = e => {
        const h = Math.max(SNAP_MIN, snap((startH + e.clientY - startY) / PX_PER_HOUR * 60) / 60 * PX_PER_HOUR);
        blk.style.height = h + "px";
      };
      const onUp = async () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        blk.removeClass("is-resizing");
        const task = this.findTask(blk.dataset.taskId);
        if (!task || task.scheduledTimes.length <= si) return;
        const st     = task.scheduledTimes[si];
        const durMin = snap(blk.offsetHeight / PX_PER_HOUR * 60);
        const endMin = st.start.hour * 60 + st.start.minute + durMin;
        await this.write(c => updateTime(c, task.lineStart, { start: st.start, end: { hour:Math.floor(endMin/60), minute:endMin%60 } }, si));
      };
      rz.addEventListener("mousedown", e => {
        e.preventDefault(); e.stopPropagation();
        startY = e.clientY; startH = blk.offsetHeight;
        blk.addClass("is-resizing");
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
      });
    }
  }

  // ── Task block resize (top) ──────────────────────────────────────
  setupResizeTop() {
    for (const [key, blk] of this.el.taskBlocks) {
      const rz = blk.querySelector(".task-block-resize-top");
      if (!rz) continue;
      const si = parseInt(blk.dataset.slotIndex || "0");
      let startY = 0, startTop = 0, startH = 0;
      const onMove = e => {
        const h = Math.max(SNAP_MIN, snap((startH - (e.clientY - startY)) / PX_PER_HOUR * 60) / 60 * PX_PER_HOUR);
        blk.style.top    = `${startTop + startH - h}px`;
        blk.style.height = h + "px";
      };
      const onUp = async () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        blk.removeClass("is-resizing");
        const task = this.findTask(blk.dataset.taskId);
        if (!task || task.scheduledTimes.length <= si) return;
        const start  = px2time(parseFloat(blk.style.top));
        const durMin = snap(blk.offsetHeight / PX_PER_HOUR * 60);
        const endMin = start.hour * 60 + start.minute + durMin;
        await this.write(c => updateTime(c, task.lineStart, { start, end: { hour:Math.floor(endMin/60), minute:endMin%60 } }, si));
      };
      rz.addEventListener("mousedown", e => {
        e.preventDefault(); e.stopPropagation();
        startY = e.clientY; startTop = parseFloat(blk.style.top); startH = blk.offsetHeight;
        blk.addClass("is-resizing");
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
      });
    }
  }

  // ── Schedule block resize (both ends) ───────────────────────────
  setupSchedResizes() {
    for (const [key, blk] of this.el.schedBlocks) {
      const si = parseInt(blk.dataset.slotIndex || "0");
      const rzBot = blk.querySelector(".task-block-resize");
      if (rzBot) {
        let startY = 0, startH = 0;
        const onMove = e => {
          blk.style.height = Math.max(SNAP_MIN, snap((startH + e.clientY - startY) / PX_PER_HOUR * 60) / 60 * PX_PER_HOUR) + "px";
        };
        const onUp = async () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup",   onUp);
          const sb = this.findSchedBlock(blk.dataset.schedId);
          if (!sb || sb.scheduledTimes.length <= si) return;
          const st     = sb.scheduledTimes[si];
          const durMin = snap(blk.offsetHeight / PX_PER_HOUR * 60);
          const endMin = st.start.hour * 60 + st.start.minute + durMin;
          await this.write(c => updateTime(c, sb.lineStart, { start: st.start, end: { hour:Math.floor(endMin/60), minute:endMin%60 } }, si));
        };
        rzBot.addEventListener("mousedown", e => {
          e.preventDefault(); e.stopPropagation();
          startY = e.clientY; startH = blk.offsetHeight;
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup",   onUp);
        });
      }

      const rzTop = blk.querySelector(".task-block-resize-top");
      if (rzTop) {
        let startY = 0, startTop = 0, startH = 0;
        const onMove = e => {
          const h = Math.max(SNAP_MIN, snap((startH - (e.clientY - startY)) / PX_PER_HOUR * 60) / 60 * PX_PER_HOUR);
          blk.style.top    = `${startTop + startH - h}px`;
          blk.style.height = h + "px";
        };
        const onUp = async () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup",   onUp);
          const sb = this.findSchedBlock(blk.dataset.schedId);
          if (!sb || sb.scheduledTimes.length <= si) return;
          const start  = px2time(parseFloat(blk.style.top));
          const durMin = snap(blk.offsetHeight / PX_PER_HOUR * 60);
          const endMin = start.hour * 60 + start.minute + durMin;
          await this.write(c => updateTime(c, sb.lineStart, { start, end: { hour:Math.floor(endMin/60), minute:endMin%60 } }, si));
        };
        rzTop.addEventListener("mousedown", e => {
          e.preventDefault(); e.stopPropagation();
          startY = e.clientY; startTop = parseFloat(blk.style.top); startH = blk.offsetHeight;
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup",   onUp);
        });
      }
    }
  }

  // ── Task block context menu ──────────────────────────────────────
  setupTaskContextMenu() {
    for (const [key, blk] of this.el.taskBlocks) {
      blk.addEventListener("contextmenu", e => {
        e.preventDefault(); e.stopPropagation();
        const task = this.findTask(blk.dataset.taskId);
        if (!task) return;
        const si   = parseInt(blk.dataset.slotIndex || "0");
        const menu = new Menu();
        menu.addItem(i => i.setTitle("Add another slot").setIcon("plus").onClick(async () => {
          const last   = task.scheduledTimes[task.scheduledTimes.length - 1];
          const e2     = last.end || { hour: last.start.hour + 1, minute: last.start.minute };
          const endMin = e2.hour * 60 + e2.minute + DEFAULT_SLOT_MIN;
          await this.write(c => addTime(c, task.lineStart, { start: e2, end: { hour:Math.floor(endMin/60), minute:endMin%60 } }), true);
        }));
        menu.addSeparator();
        menu.addItem(i => i.setTitle("Remove from timeline").setIcon("trash").onClick(async () => {
          await this.write(c => removeTime(c, task.lineStart, si), true);
        }));
        menu.showAtMouseEvent(e);
      });
    }
  }

  // ── Schedule block context menu ──────────────────────────────────
  setupSchedContextMenu() {
    for (const [key, blk] of this.el.schedBlocks) {
      blk.addEventListener("contextmenu", e => {
        e.preventDefault(); e.stopPropagation();
        const sb = this.findSchedBlock(blk.dataset.schedId);
        if (!sb) return;
        const si   = parseInt(blk.dataset.slotIndex || "0");
        const menu = new Menu();
        menu.addItem(i => i.setTitle("Remove from timeline").setIcon("trash").onClick(async () => {
          await this.write(c => removeTime(c, sb.lineStart, si), true);
        }));
        menu.showAtMouseEvent(e);
      });
    }
  }

  // ── Right-click empty timeline → create new block in daily note ──
  setupGridContextMenu() {
    this.el.slots.addEventListener("contextmenu", e => {
      if (e.target.closest(".task-block")) return;
      e.preventDefault();
      const rect   = this.el.slots.getBoundingClientRect();
      const start  = px2time(Math.max(0, e.clientY - rect.top));
      const endMin = start.hour * 60 + start.minute + 60;
      const end    = { hour: Math.floor(endMin / 60), minute: endMin % 60 };

      const menu = new Menu();
      const presets = ["Lunch", "Unwind time", "Break", "Exercise", "Coffee"];
      for (const label of presets) {
        menu.addItem(i => i.setTitle(label).onClick(async () => {
          await this.write(c => appendScheduleBlock(c, label, { start, end }), true);
        }));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle("Custom block…").setIcon("edit").onClick(() => {
        promptBlockName(async label => {
          await this.write(c => appendScheduleBlock(c, label, { start, end }), true);
        });
      }));
      menu.showAtMouseEvent(e);
    });
  }

  // ── Click to navigate ────────────────────────────────────────────
  setupClickToNavigate() {
    const navigate = lineStart => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file === this.file) {
        view.editor.setCursor(lineStart, 0);
        view.editor.scrollIntoView({ from:{line:lineStart,ch:0}, to:{line:lineStart,ch:0} }, true);
      }
    };
    for (const [key, blk] of this.el.taskBlocks) {
      blk.addEventListener("click", e => {
        if (e.target.className?.includes?.("task-block-resize")) return;
        const task = allTasks(this.daily).find(t => t.id === blk.dataset.taskId);
        if (task) navigate(task.lineStart);
      });
    }
    for (const [id, item] of this.el.poolItems) {
      item.addEventListener("click", () => {
        const task = allTasks(this.daily).find(t => t.id === id);
        if (task) navigate(task.lineStart);
      });
    }
    for (const [key, blk] of this.el.schedBlocks) {
      blk.addEventListener("click", e => {
        if (e.target.className?.includes?.("task-block-resize")) return;
        const sb = this.findSchedBlock(blk.dataset.schedId);
        if (sb) navigate(sb.lineStart);
      });
    }
    for (const [id, item] of this.el.schedPoolItems) {
      item.addEventListener("click", () => {
        const sb = this.findSchedBlock(id);
        if (sb) navigate(sb.lineStart);
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────
  findTask(id)       { return allTasks(this.daily).find(t => t.id === id); }
  findSchedBlock(id) { return this.daily.scheduleBlocks.find(b => b.id === id); }

  getSlotDur(task, si) {
    const slot = task.scheduledTimes[si];
    if (!slot) return DEFAULT_SLOT_MIN;
    const e = slot.end;
    return e ? e.hour*60+e.minute - (slot.start.hour*60+slot.start.minute) : DEFAULT_SLOT_MIN;
  }
  getSchedDur(sb, si) {
    const slot = sb.scheduledTimes[si];
    if (!slot) return DEFAULT_SLOT_MIN;
    const e = slot.end;
    return e ? e.hour*60+e.minute - (slot.start.hour*60+slot.start.minute) : DEFAULT_SLOT_MIN;
  }

  async write(fn, immediate = false) {
    if (this.writeTimeout) clearTimeout(this.writeTimeout);
    const exec = async () => {
      const content = await this.app.vault.read(this.file);
      const updated = fn(content);
      if (updated !== content) {
        this.suppressNextModify = true;
        await this.app.vault.modify(this.file, updated);
        this.daily = parseDailyNote(updated, this.file.path);
        this.onRefresh();
      }
    };
    if (immediate) await exec();
    else this.writeTimeout = setTimeout(exec, 150);
  }
}

// ═══════════════════════════════════════════════════════════════════
// View
// ═══════════════════════════════════════════════════════════════════
class DayTimelineView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.nowInterval = null;
    this.elements    = null;
    this.dragHandler = null;
    this.currentFile = null;
    this.daily       = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return "Day Timeline"; }
  getIcon()        { return "calendar-clock"; }

  async onOpen() {
    this.renderEmpty();
    this.nowInterval = setInterval(() => {
      if (this.elements) updateNowLine(this.elements.nowLine);
    }, 60000);
  }

  async onClose() {
    if (this.nowInterval) { clearInterval(this.nowInterval); this.nowInterval = null; }
  }

  renderEmpty() {
    this.elements = render(this.contentEl, null);
  }

  async refresh(file) {
    if (!this.isDailyNote(file)) {
      if (!this.currentFile) this.renderEmpty();
      return;
    }
    this.currentFile = file;
    const content = await this.app.vault.read(file);
    this.daily    = parseDailyNote(content, file.path);

    const scrollTop = this.contentEl.querySelector(".day-timeline-grid")?.scrollTop ?? 0;
    this.elements   = render(this.contentEl, this.daily);
    const grid = this.contentEl.querySelector(".day-timeline-grid");
    if (grid) grid.scrollTop = scrollTop;

    this.dragHandler = new DragHandler(
      this.app, file, this.daily, this.elements,
      () => this.refresh(file)
    );
    this.dragHandler.setup();
  }

  get handler() { return this.dragHandler; }

  isDailyNote(file) {
    return /daily notes\/\d{4}-\d{2}-\d{2}\.md$/.test(file.path);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CodeMirror editor extension (drag handle in editor)
// ═══════════════════════════════════════════════════════════════════
class TaskHandle extends WidgetType {
  constructor(line) { super(); this.line = line; }
  eq(other) { return this.line === other.line; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "day-timeline-editor-handle";
    el.draggable = true;
    el.dataset.line = String(this.line);
    el.textContent = "⠟";
    return el;
  }
  ignoreEvent() { return true; }
}

function taskEndLine(doc, startLine) {
  for (let i = startLine + 1; i <= doc.lines; i++)
    if (!RE_SUB.test(doc.line(i).text)) return i - 1;
  return doc.lines;
}

function findTaskLines(doc) {
  const out = [];
  for (let i = 1; i <= doc.lines; i++)
    if (RE_TASK.test(doc.line(i).text)) out.push(i);
  return out;
}

const editorPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.dropIndicator  = null;
    this.dragSourceLine = null;
    this.dragGhost      = null;
    this.boundHandlers  = [];
    this.decorations    = this.build(view);
    this.attach();
  }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
  }
  destroy() {
    for (const { type, fn, cap } of this.boundHandlers)
      this.view.dom.removeEventListener(type, fn, cap);
    this.cleanup();
  }
  build(view) {
    const b = new RangeSetBuilder(), doc = view.state.doc;
    let inSchedule = false;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (RE_SCHEDULE.test(line.text))   { inSchedule = true;  continue; }
      if (/^##\s+/.test(line.text))      { inSchedule = false; }
      if (RE_TASK.test(line.text) || (inSchedule && RE_BLOCK.test(line.text)))
        b.add(line.from, line.from, Decoration.widget({ widget: new TaskHandle(i), side: -1 }));
    }
    return b.finish();
  }
  on(type, fn, cap = false) {
    this.view.dom.addEventListener(type, fn, cap);
    this.boundHandlers.push({ type, fn, cap });
  }
  attach() {
    this.on("dragstart", e => this.onDragStart(e));
    this.on("dragover",  e => this.onDragOver(e), true);
    this.on("drop",      e => this.onDrop(e), true);
    this.on("dragleave", e => this.onDragLeave(e));
    this.on("dragend",   () => this.onDragEnd());
  }

  onDragStart(e) {
    const tgt = e.target;
    if (!tgt.classList?.contains("day-timeline-editor-handle") || !e.dataTransfer) return;
    const line = parseInt(tgt.dataset.line || "0");
    if (!line) return;
    const doc = this.view.state.doc;
    if (line > doc.lines) return;
    const end = taskEndLine(doc, line);
    this.dragSourceLine = line;
    e.dataTransfer.setData("application/day-timeline-editor", JSON.stringify({ lineStart: line-1, startLine: line, endLine: end }));
    e.dataTransfer.setData("text/plain", "");
    e.dataTransfer.effectAllowed = "move";

    const text  = doc.line(line).text.replace(/^- \[[ x]\]\s+/,"").replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g,"").replace(/#[\w-]+/g,"").trim();
    const slots = document.querySelector(".day-timeline-slots");
    const w     = slots ? slots.clientWidth - 8 : 150;
    const g     = document.createElement("div");
    g.className = "task-block";
    g.style.cssText = `position:fixed;top:-1000px;left:-1000px;width:${w}px;height:60px;background:var(--interactive-accent);border-radius:4px;padding:4px 6px;opacity:.85;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.25)`;
    const span = document.createElement("span"); span.className = "task-block-text";
    span.textContent = (text || "Task").slice(0, 40);
    g.appendChild(span); document.body.appendChild(g);
    e.dataTransfer.setDragImage(g, 4, 0);
    this.dragGhost = g;
    tgt.classList.add("is-dragging");
  }

  onDragOver(e) {
    if (!e.dataTransfer) return;
    const types    = Array.from(e.dataTransfer.types);
    const isEditor = types.includes("application/day-timeline-editor");
    const isBlock  = types.includes("application/day-timeline-block");
    const isSchedB = types.includes("application/day-timeline-sched-block");
    if (!isEditor && !isBlock && !isSchedB) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (isBlock || isSchedB) return;  // blocks just need dragover acceptance, no indicator

    const slotsEl = document.querySelector(".day-timeline-slots");
    if (slotsEl) {
      const r = slotsEl.getBoundingClientRect();
      if (e.clientX > r.left - (slotsEl.clientWidth - 8) / 2) {
        if (this.dropIndicator) this.dropIndicator.style.display = "none";
        return;
      }
    }

    const doc = this.view.state.doc;
    const taskLines = findTaskLines(doc);
    if (!taskLines.length) return;
    const positions = [];
    for (const l of taskLines) {
      const coords = this.view.coordsAtPos(doc.line(l).from);
      if (coords) positions.push({ line: l, y: coords.top });
    }
    const lastLine = taskLines[taskLines.length - 1];
    const lastEnd  = taskEndLine(doc, lastLine);
    const afterCoords = lastEnd < doc.lines
      ? this.view.coordsAtPos(doc.line(lastEnd + 1).from)
      : this.view.coordsAtPos(doc.line(lastEnd).to);
    if (afterCoords) positions.push({ line: lastEnd + 1, y: afterCoords.top || afterCoords.bottom });
    if (!positions.length) return;

    let best = positions[0];
    for (const p of positions) if (Math.abs(e.clientY - p.y) < Math.abs(e.clientY - best.y)) best = p;

    if (this.dragSourceLine !== null) {
      const srcEnd = taskEndLine(doc, this.dragSourceLine);
      if (best.line >= this.dragSourceLine && best.line <= srcEnd + 1) {
        if (this.dropIndicator) this.dropIndicator.style.display = "none";
        return;
      }
    }

    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement("div");
      this.dropIndicator.className = "day-timeline-drop-indicator";
      document.body.appendChild(this.dropIndicator);
    }
    const dom = this.view.contentDOM.getBoundingClientRect();
    this.dropIndicator.style.display = "";
    this.dropIndicator.style.top     = `${best.y}px`;
    this.dropIndicator.style.left    = `${dom.left}px`;
    this.dropIndicator.style.width   = `${dom.width}px`;
    this.dropIndicator.dataset.insertBefore = String(best.line);
  }

  onDrop(e) {
    if (!e.dataTransfer) return;
    const types    = Array.from(e.dataTransfer.types);
    const isEditor = types.includes("application/day-timeline-editor");
    const isBlock  = types.includes("application/day-timeline-block");
    const isSchedB = types.includes("application/day-timeline-sched-block");
    if (!isEditor && !isBlock && !isSchedB) return;
    e.preventDefault(); e.stopPropagation();

    // Both task blocks and schedule blocks: remove the @time annotation from the note line
    if (isBlock || isSchedB) { this.handleUnschedule(e); return; }

    const raw = e.dataTransfer.getData("application/day-timeline-editor");
    if (!raw) { this.cleanup(); return; }
    const { startLine, endLine } = JSON.parse(raw);

    if (this.checkScheduleSidebar(e, startLine)) return;

    const insertBefore = this.dropIndicator?.dataset.insertBefore;
    this.cleanup();
    if (!insertBefore) return;
    let target = parseInt(insertBefore);
    if (target >= startLine && target <= endLine + 1) return;

    const doc = this.view.state.doc;
    const lines = [];
    for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
    const src = startLine - 1, cnt = endLine - startLine + 1;
    const moved = lines.splice(src, cnt);
    let ins = target - 1;
    if (target > endLine) ins -= cnt;
    lines.splice(ins, 0, ...moved);

    const newContent = lines.join("\n");
    let pos = 0;
    for (let i = 0; i < ins; i++) pos += lines[i].length + 1;
    this.view.dispatch({
      changes: { from: 0, to: doc.length, insert: newContent },
      effects: EditorView.scrollIntoView(pos, { y: "nearest" }),
    });
  }

  checkScheduleSidebar(e, startLine) {
    const slots = document.querySelector(".day-timeline-slots");
    if (!slots) return false;
    const r = slots.getBoundingClientRect();
    if (e.clientX <= r.left - (slots.clientWidth - 8) * 0.5 + 4) return false;
    const start  = px2time(Math.max(0, e.clientY - r.top));
    const endMin = start.hour * 60 + start.minute + DEFAULT_SLOT_MIN;
    const end    = { hour: Math.floor(endMin/60), minute: endMin%60 };
    const ann    = `@${formatTime(start)}-${formatTime(end)}`;
    const doc    = this.view.state.doc;
    const line   = doc.line(startLine);
    const tagPos = line.text.search(/#[\w-]+/);
    const from   = tagPos !== -1 ? line.from + tagPos : line.to;
    const insert = tagPos !== -1 ? ann + " " : " " + ann;
    this.view.dispatch({ changes: { from, to: from, insert } });
    this.cleanup();
    return true;
  }

  handleUnschedule(e) {
    if (!e.dataTransfer) return;
    const lineStr = e.dataTransfer.getData("application/day-timeline-line");
    const si      = parseInt(e.dataTransfer.getData("application/day-timeline-slot") || "0");
    const lineNum = parseInt(lineStr);
    if (isNaN(lineNum) || lineNum < 0) return;
    document.querySelectorAll(".task-block").forEach(el => {
      if (el.dataset.lineStart === lineStr && parseInt(el.dataset.slotIndex || "0") === si)
        el.style.display = "none";
    });
    const doc = this.view.state.doc;
    if (lineNum + 1 > doc.lines) return;
    const line = doc.line(lineNum + 1);
    const re = /@\d{2}:\d{2}-\d{2}:\d{2}/g;
    let match, i = 0;
    while ((match = re.exec(line.text)) !== null) {
      if (i++ === si) {
        let from = line.from + match.index, to = from + match[0].length;
        if (to < line.to && line.text[match.index + match[0].length] === " ") to++;
        else if (match.index > 0 && line.text[match.index - 1] === " ") from--;
        this.view.dispatch({ changes: { from, to, insert: "" } });
        return;
      }
    }
  }

  onDragLeave(e) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes("application/day-timeline-editor") && !types.includes("application/day-timeline-block")) return;
    if (e.relatedTarget && this.view.dom.contains(e.relatedTarget)) return;
    if (this.dropIndicator) this.dropIndicator.style.display = "none";
  }

  onDragEnd() {
    this.cleanup();
    this.view.dom.querySelectorAll(".day-timeline-editor-handle.is-dragging")
      .forEach(el => el.classList.remove("is-dragging"));
  }

  cleanup() {
    this.dropIndicator?.remove(); this.dropIndicator = null;
    this.dragGhost?.remove();     this.dragGhost     = null;
    this.dragSourceLine = null;
  }
}, { decorations: p => p.decorations });

// ═══════════════════════════════════════════════════════════════════
// Plugin
// ═══════════════════════════════════════════════════════════════════
class DayTimelinePlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.modifyTimeout = null;
  }

  async onload() {
    this.registerView(VIEW_TYPE, leaf => new DayTimelineView(leaf));
    this.addRibbonIcon("calendar-clock", "Day Timeline", () => this.activateView());
    this.addCommand({ id: "open-day-timeline", name: "Open Day Timeline", callback: () => this.activateView() });
    this.registerEditorExtension(editorPlugin);

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.vault.on("modify", file => {
      if (!(file instanceof TFile)) return;
      const view = this.getView();
      if (!view) return;
      if (view.handler?.shouldSuppressModify) return;
      if (this.modifyTimeout) clearTimeout(this.modifyTimeout);
      this.modifyTimeout = setTimeout(() => this.refresh(), 80);
    }));
    this.app.workspace.onLayoutReady(() => this.refresh());
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) { this.app.workspace.revealLeaf(leaves[0]); this.refresh(); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      this.refresh();
    }
  }

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  refresh() {
    const view = this.getView();
    if (!view) return;
    const file = this.app.workspace.getActiveFile();
    if (file) view.refresh(file);
  }
}

export default DayTimelinePlugin;
