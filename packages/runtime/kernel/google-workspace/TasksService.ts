/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, tasks_v1 } from "googleapis";
import { AuthManager } from "./AuthManager.js";
import { logToFile } from "./logger.js";
import { createGoogleClientOptions } from "./GaxiosConfig.js";

const DEFAULT_TASKLIST = "@default";

/**
 * Minimal Google Tasks service backing the Workspace demo. Uses the
 * shared Google grant's `tasks` scope for list/create/update/complete.
 */
export class TasksService {
  constructor(private authManager: AuthManager) {}

  private async getTasksClient(): Promise<tasks_v1.Tasks> {
    const auth = await this.authManager.getAuthenticatedClient();
    return google.tasks({
      version: "v1",
      ...createGoogleClientOptions(auth),
    });
  }

  private ok(payload: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  private handleError(
    context: string,
    error: unknown,
  ): {
    isError: true;
    content: { type: "text"; text: string }[];
  } {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logToFile(`Error during ${context}: ${errorMessage}`);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
    };
  }

  /** Lists the user's task lists. */
  public listTaskLists = async () => {
    try {
      const tasks = await this.getTasksClient();
      const res = await tasks.tasklists.list({ maxResults: 100 });
      return this.ok({
        taskLists: (res.data.items ?? []).map((list) => ({
          id: list.id,
          title: list.title,
          updated: list.updated,
        })),
      });
    } catch (error) {
      return this.handleError("tasks.listTaskLists", error);
    }
  };

  /** Lists tasks within a task list (defaults to the primary list). */
  public list = async ({
    tasklist,
    showCompleted,
  }: {
    tasklist?: string;
    showCompleted?: boolean;
  } = {}) => {
    try {
      const tasks = await this.getTasksClient();
      const includeCompleted = showCompleted === true;
      const res = await tasks.tasks.list({
        tasklist: tasklist || DEFAULT_TASKLIST,
        showCompleted: includeCompleted,
        showHidden: includeCompleted,
        maxResults: 100,
      });
      return this.ok({
        tasklist: tasklist || DEFAULT_TASKLIST,
        tasks: (res.data.items ?? []).map((task) => ({
          id: task.id,
          title: task.title,
          notes: task.notes,
          status: task.status,
          due: task.due,
          completed: task.completed,
        })),
      });
    } catch (error) {
      return this.handleError("tasks.list", error);
    }
  };

  /** Creates a task in a task list (defaults to the primary list). */
  public create = async ({
    tasklist,
    title,
    notes,
    due,
  }: {
    tasklist?: string;
    title: string;
    notes?: string;
    due?: string;
  }) => {
    try {
      const tasks = await this.getTasksClient();
      const requestBody: tasks_v1.Schema$Task = { title };
      if (typeof notes === "string") requestBody.notes = notes;
      if (typeof due === "string") requestBody.due = due;
      const res = await tasks.tasks.insert({
        tasklist: tasklist || DEFAULT_TASKLIST,
        requestBody,
      });
      return this.ok({
        id: res.data.id,
        title: res.data.title,
        notes: res.data.notes,
        status: res.data.status,
        due: res.data.due,
      });
    } catch (error) {
      return this.handleError("tasks.create", error);
    }
  };

  /** Updates mutable fields of a task. */
  public update = async ({
    tasklist,
    taskId,
    title,
    notes,
    due,
    status,
  }: {
    tasklist?: string;
    taskId: string;
    title?: string;
    notes?: string;
    due?: string;
    status?: "needsAction" | "completed";
  }) => {
    try {
      if (!taskId) throw new Error("taskId is required.");
      const tasks = await this.getTasksClient();
      const requestBody: tasks_v1.Schema$Task = {};
      if (typeof title === "string") requestBody.title = title;
      if (typeof notes === "string") requestBody.notes = notes;
      if (typeof due === "string") requestBody.due = due;
      if (status === "needsAction" || status === "completed") {
        requestBody.status = status;
        // Clearing completion is required when reopening a task.
        if (status === "needsAction") requestBody.completed = null;
      }
      const res = await tasks.tasks.patch({
        tasklist: tasklist || DEFAULT_TASKLIST,
        task: taskId,
        requestBody,
      });
      return this.ok({
        id: res.data.id,
        title: res.data.title,
        notes: res.data.notes,
        status: res.data.status,
        due: res.data.due,
        completed: res.data.completed,
      });
    } catch (error) {
      return this.handleError("tasks.update", error);
    }
  };

  /** Marks a task as completed. */
  public complete = async ({
    tasklist,
    taskId,
  }: {
    tasklist?: string;
    taskId: string;
  }) => {
    try {
      if (!taskId) throw new Error("taskId is required.");
      const tasks = await this.getTasksClient();
      const res = await tasks.tasks.patch({
        tasklist: tasklist || DEFAULT_TASKLIST,
        task: taskId,
        requestBody: { status: "completed" },
      });
      return this.ok({
        id: res.data.id,
        title: res.data.title,
        status: res.data.status,
        completed: res.data.completed,
      });
    } catch (error) {
      return this.handleError("tasks.complete", error);
    }
  };
}
