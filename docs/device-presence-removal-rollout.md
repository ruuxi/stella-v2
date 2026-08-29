# Device presence removal rollout

This is a one-time coordinated rollout note for the removal of the legacy
`device_presence` table and its public Convex functions. It is not an ongoing
runtime compatibility contract.

1. Release the desktop containing this removal while the old backend remains
   deployed. The new desktop is compatible with that backend and simply stops
   calling the legacy functions.
2. Require all supported signed-in desktop installations to update to that
   release. Do not continue until the minimum supported desktop version is the
   removal release (or newer); a dormant older desktop must update before it is
   allowed to reconnect.
3. Delete all rows in the historical `device_presence` table with the Convex
   dashboard's **Delete table** action. Do this only after step 2 so an old
   desktop cannot recreate rows between cleanup and deployment.
4. Immediately deploy this backend revision, which removes the table from the
   schema and removes the old functions.

Reversing steps 1 and 4 makes old desktops receive function-not-found errors on
every heartbeat. Keeping a permanent no-op function is intentionally not part
of the final architecture.
