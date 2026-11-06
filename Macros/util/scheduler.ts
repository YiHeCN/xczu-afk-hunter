// oxlint-disable no-unused-vars

// scheduler.js

export const TaskStatus = {
    IDLE: "idle",
    RUNNING: "running",
    SUSPENDED: "suspended",
    COMPLETED: "completed",
};

export const TaskResult = {
    RUNNING: "running",
    COMPLETED: "completed",
};

export class Task {
    name: string;
    priority: number;
    status: string;

    constructor(name: string, priority: number) {
        this.name = name;
        this.priority = priority;
        this.status = TaskStatus.IDLE;
    }

    // 是否满足执行条件
    shouldRun(context) {
        return false;
    }

    // 首次启动
    start(context) { }

    // 每个 Tick 执行
    tick(context) {
        return TaskResult.RUNNING;
    }

    // 被更高优先级任务抢占
    suspend(context) { }

    // 从暂停状态恢复
    resume(context) { }

    // 正常完成
    finish(context) { }

    // 被强制中止
    abort(context, reason) { }

    // 清除历史状态，允许重新执行
    reset() {
        this.status = TaskStatus.IDLE;
    }
}

export class Scheduler {
    context: any;
    tasks: Map<string, Task>;
    current: Task | null;
    forcedTask: Task | null;
    running: boolean;

    constructor(context: any = {}) {
        this.context = context;
        this.tasks = new Map();

        this.current = null;
        this.forcedTask = null;
        this.running = false;
    }

    register(task) {
        if (this.tasks.has(task.name)) {
            throw new Error(`Duplicate task: ${task.name}`);
        }

        this.tasks.set(task.name, task);
        return this;
    }

    getTask(name) {
        return this.tasks.get(name);
    }

    // 获取当前最应该执行的任务
    selectTask() {
        return [...this.tasks.values()]
            .filter(task =>
                task.status !== TaskStatus.COMPLETED &&
                task.shouldRun(this.context)
            )
            .sort((a, b) => b.priority - a.priority)[0] ?? null;
    }

    // 切换任务
    switchTo(next) {
        if (this.current === next) return;

        const previous = this.current;

        if (previous) {
            previous.suspend(this.context);
            previous.status = TaskStatus.SUSPENDED;
        }

        this.current = next;

        if (!next) return;

        if (next.status === TaskStatus.SUSPENDED) {
            next.resume(this.context);
        } else {
            next.start(this.context);
        }

        next.status = TaskStatus.RUNNING;
    }

    // 普通 Tick
    tick() {
        if (!this.running) return;

        try {
            // 硬中断任务拥有绝对优先权
            const next = this.forcedTask ?? this.selectTask();
            this.forcedTask = null;

            this.switchTo(next);

            if (!this.current) return;

            const result = this.current.tick(this.context);

            if (result === TaskResult.COMPLETED) {
                const completed = this.current;

                completed.finish(this.context);
                completed.status = TaskStatus.COMPLETED;

                this.current = null;
            }
        } catch (error) {
            this.handleError(error);
        }
    }

    // 立即中断全部任务，指定任务接管
    hardInterrupt(taskName, reason = "hard interrupt") {
        const emergency = this.getTask(taskName);

        if (!emergency) {
            throw new Error(`Task not found: ${taskName}`);
        }

        // 先终止所有正在运行或暂停的任务
        for (const task of this.tasks.values()) {
            if (task !== emergency &&
                task.status !== TaskStatus.IDLE &&
                task.status !== TaskStatus.COMPLETED) {
                try {
                    task.abort(this.context, reason);
                } finally {
                    task.reset();
                }
            }
        }

        this.current = null;
        emergency.reset();
        this.forcedTask = emergency;
    }

    // 任务错误处理
    handleError(error) {
        const failed = this.current;

        if (failed) {
            try {
                failed.abort(this.context, error);
            } finally {
                failed.reset();
            }
        }

        this.current = null;

        const message = `[Scheduler] ${error?.stack ?? error}`;
        if (typeof this.context.logger?.error === "function") this.context.logger.error(message);
        else Chat.log(message);
    }

    start() {
        this.running = true;
    }

    stop() {
        this.running = false;

        for (const task of this.tasks.values()) {
            if (task.status === TaskStatus.RUNNING ||
                task.status === TaskStatus.SUSPENDED) {
                task.abort(this.context, "scheduler stopped");
                task.reset();
            }
        }

        this.current = null;
        this.forcedTask = null;
    }
}
