/**
 * Task Manager — 内存任务状态管理 + SSE 实时事件推送
 *
 * 职责:
 * 1. 管理异步任务的生命周期 (queued → routing → executing → delivering → done/failed)
 * 2. 记录任务事件流 (events[])
 * 3. 提供 SSE 订阅接口，让客户端实时监控任务进度
 */

import { EventEmitter } from "events";

// ── Task Types ────────────────────────────────────────────────────────────────

export type TaskStatus = "queued" | "routing" | "executing" | "delivering" | "done" | "failed";

export interface TaskEvent {
  timestamp: string;
  status: TaskStatus;
  message: string;
  data?: Record<string, unknown>;
}

export interface AsyncTask {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Which agent is handling this task */
  agentId?: string;
  agentName?: string;
  /** Where to deliver the result */
  webhookUrl?: string;
  /** The original user input */
  input: string;
  /** The result text (populated when done) */
  output?: string;
  /** Delivery status */
  webhookDelivered?: boolean;
  webhookError?: string;
  /** Full event history */
  events: TaskEvent[];
}

// ── Task Manager ──────────────────────────────────────────────────────────────

class TaskManager extends EventEmitter {
  private tasks = new Map<string, AsyncTask>();

  /** Auto-cleanup: remove tasks older than 1 hour */
  private readonly TTL_MS = 60 * 60 * 1000;

  constructor() {
    super();
    // Cleanup every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  /** Create a new task */
  create(id: string, input: string, webhookUrl?: string): AsyncTask {
    const now = new Date().toISOString();
    const task: AsyncTask = {
      id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      input,
      webhookUrl,
      events: [{ timestamp: now, status: "queued", message: "Task created" }],
    };
    this.tasks.set(id, task);
    this.emit(`task:${id}`, task.events[task.events.length - 1]);
    return task;
  }

  /** Get a task by ID */
  get(id: string): AsyncTask | undefined {
    return this.tasks.get(id);
  }

  /** Update task status and append an event */
  update(
    id: string,
    status: TaskStatus,
    message: string,
    data?: Record<string, unknown>
  ): void {
    const task = this.tasks.get(id);
    if (!task) return;

    const now = new Date().toISOString();
    task.status = status;
    task.updatedAt = now;

    if (data?.agentId) task.agentId = data.agentId as string;
    if (data?.agentName) task.agentName = data.agentName as string;
    if (data?.output) task.output = data.output as string;
    if (data?.webhookDelivered !== undefined) task.webhookDelivered = data.webhookDelivered as boolean;
    if (data?.webhookError) task.webhookError = data.webhookError as string;

    const event: TaskEvent = { timestamp: now, status, message, data };
    task.events.push(event);

    // Emit for SSE subscribers
    this.emit(`task:${id}`, event);
  }

  /** List all active tasks */
  list(): AsyncTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /** Get summary stats */
  stats(): { total: number; byStatus: Record<string, number> } {
    const byStatus: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    }
    return { total: this.tasks.size, byStatus };
  }

  /** Remove old tasks */
  private cleanup(): void {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [id, task] of this.tasks) {
      if (new Date(task.updatedAt).getTime() < cutoff) {
        this.tasks.delete(id);
      }
    }
  }
}

// Singleton
export const taskManager = new TaskManager();
