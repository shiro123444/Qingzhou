export interface ScheduleNextTopicParams {
  delay?: number; // delay in seconds, default 0
  expectedVersion?: string;
  taskId: string;
  userId: string;
}

export interface TaskSchedulerImpl {
  cancelScheduled: (scheduleId: string, userId?: string) => Promise<void>;

  scheduleNextTopic: (params: ScheduleNextTopicParams) => Promise<string>;
}
