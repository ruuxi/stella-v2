-- The X bot worker (workers/x-bot) is gone; dropping the table drops its
-- indexes with it.
DROP TABLE IF EXISTS x_bot_runs;
