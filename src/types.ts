export interface TimeRange {
  start: { hour: number; minute: number };
  end: { hour: number; minute: number } | null;
}

export interface Task {
  id: string;
  text: string;
  checked: boolean;
  scheduledTime: TimeRange | null;
  tags: string[];
  subtaskLines: string[];
  lineStart: number;
  lineEnd: number;
  rawLines: string[];
  section: string;
}

export interface Section {
  heading: string;
  headingLine: number;
  tasks: Task[];
}

export interface DailyNote {
  filePath: string;
  date: string;
  sections: Section[];
  allLines: string[];
}
