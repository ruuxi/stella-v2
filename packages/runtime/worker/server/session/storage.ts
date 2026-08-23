import { Context, Effect, Layer } from "effect";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import { createDesktopDatabase } from "../../../kernel/storage/database.js";
import { ChatStore } from "../../../kernel/storage/chat-store.js";
import { RuntimeStore } from "../../../kernel/storage/runtime-store.js";
import { RunEventLog } from "../../../kernel/storage/run-event-log.js";
import type {
  LocalChatEventRecord,
  SqliteDatabase,
} from "../../../kernel/storage/shared.js";
import { SocialSessionStore } from "../../social-sessions/store.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";

/**
 * The session's SQLite database and every store carved out of it, as one
 * scoped resource. This layer sits at the bottom of the session chain so its
 * `db.close()` finalizer runs LAST on teardown: nothing may touch the db
 * after it, and the runner's finalizer (which drains compaction writes) and
 * the RunEventBus finalizer (`runEventLog.stop()`) are guaranteed to have
 * completed first by finalizer ordering — the old stopWorkerServices order.
 */
export interface Interface {
  readonly db: SqliteDatabase;
  readonly chatStore: ChatStore;
  readonly runtimeStore: RuntimeStore;
  readonly socialSessionStore: SocialSessionStore;
  readonly runEventLog: RunEventLog;
  /**
   * LOCAL_CHAT_UPDATED fan-out, exactly as the old top-level
   * `notifyLocalChatUpdated` helper emitted it.
   */
  readonly notifyLocalChatUpdated: (
    conversationId?: string,
    event?: LocalChatEventRecord,
  ) => void;
  /** appendEvent + LOCAL_CHAT_UPDATED notify in one step. */
  readonly appendChatEventAndNotify: (
    args: Parameters<ChatStore["appendEvent"]>[0],
  ) => LocalChatEventRecord;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/SessionStorage",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const db = createDesktopDatabase(config.get().stellaDataDirPath);
    const chatStore = new ChatStore(db, {
      onThreadActivityUpdate: (payload) => {
        hostBus.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
      onThreadAssistantUpdate: (payload) => {
        hostBus.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
      onThreadTranscriptUpdate: (payload) => {
        hostBus.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
    });
    const runtimeStore = chatStore as RuntimeStore;
    const socialSessionStore = new SocialSessionStore(db);
    const runEventLog = new RunEventLog(db);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close();
      }),
    );

    const notifyLocalChatUpdated = (
      conversationId?: string,
      event?: LocalChatEventRecord,
    ) => {
      hostBus.notify(
        NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
        event || conversationId
          ? {
              ...(conversationId ? { conversationId } : {}),
              ...(event ? { event } : {}),
            }
          : null,
      );
    };

    const appendChatEventAndNotify: Interface["appendChatEventAndNotify"] = (
      args,
    ) => {
      const event = chatStore.appendEvent(args);
      notifyLocalChatUpdated(args.conversationId, event);
      return event;
    };

    return {
      db,
      chatStore,
      runtimeStore,
      socialSessionStore,
      runEventLog,
      notifyLocalChatUpdated,
      appendChatEventAndNotify,
    };
  }),
);
