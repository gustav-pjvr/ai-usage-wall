export type TaskStatus = 'Not started' | 'In progress' | 'Waiting' | 'Done' | 'Dropped';
export type TaskPriority = 'High' | 'Medium' | 'Low';
export type TaskGroup = 'topics' | 'group_mm861qv1' | 'group_mm86nn5y' | 'group_mm86644p';

export interface TaskCard {
  id: string;
  name: string;
  group: TaskGroup;
  status: TaskStatus;
  priority: TaskPriority | null;
  due: string | null;
  ownerIds: string[];
  assignedByIds: string[];
  project: string | null;
  updatedAt: string;
}

export interface TasksView {
  at: string;
  columns: {
    inProgress: TaskCard[];
    waiting: TaskCard[];
    backlog: TaskCard[];
    done: TaskCard[];
  };
  counts: {
    inProgress: number;
    waiting: number;
    backlog: number;
    done: number;
    overdue: number;
    dueThisWeek: number;
    newFromJaco: number;
    doneThisWeek: number;
  };
}

export interface TaskEvent {
  id: string;
  kind: 'assigned' | 'moved' | 'commented' | 'leftWaiting';
  taskId: string;
  taskName: string;
  actorId: string;
  at: string;
}
