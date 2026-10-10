# Google Workspace OAuth verification evidence

Stella uses one shared Google grant for Gmail, Calendar, Drive, Docs, Sheets,
and Tasks. Every current connect or legacy-grant upgrade requests the complete
reviewed union below. Runtime scope definitions are in
`packages/runtime/kernel/google-workspace/scopes.ts`; the hosted provider
registration is in `packages/backend/convex/connectors/oauth/providers.ts`.

## Exact requested scopes

Mandatory account identity scopes, separate from Workspace data access:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

The exact six Workspace data scopes:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/tasks`

The OAuth flow uses authorization code with PKCE, requests offline access, and
sets `include_granted_scopes=true`. The latter lets an older partial grant be
upgraded to this complete union while preserving its existing refresh token
when Google omits a new one.

## Implemented action evidence and scope rationale

| Scope          | User-visible implemented actions                                                                                                                                        | Why a narrower scope is insufficient                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail.modify` | Search/read messages, fetch attachments, change labels, create/send drafts, and send mail (`GmailService.ts`; Gmail entries in `tool-allowlist.ts`).                    | Read-only cannot organize or send; send/compose scopes cannot perform the implemented message and thread label changes. This scope excludes permanent message deletion.                                                                             |
| `calendar`     | List calendars and events, create/update events, respond to invitations, and query free/busy (`CalendarService.ts`; Calendar allowlist entries).                        | Read-only cannot create, update, or respond. The current API calls require event write, calendar-list read, and free/busy access. See the narrower-scope caveat below.                                                                              |
| `documents`    | Create/read Docs, read suggestions, insert/replace text, and format content (`DocsService.ts`; Docs allowlist entries).                                                 | `documents.readonly` cannot perform create or batch-update operations.                                                                                                                                                                              |
| `drive`        | Search arbitrary existing Drive files/folders, create folders, inspect/download selected files, and rename selected files (`DriveService.ts`; Drive allowlist entries). | `drive.file` is limited to files created by or explicitly opened with the app and cannot support arbitrary existing-file search/download/rename. Read-only Drive access cannot rename files or create folders. See the narrower-scope caveat below. |
| `spreadsheets` | Create spreadsheets, read cells/metadata, update cells, append rows, and add tabs (`SheetsService.ts`; Sheets allowlist entries).                                       | `spreadsheets.readonly` cannot perform create/update/append/add-sheet actions.                                                                                                                                                                      |
| `tasks`        | List task lists/tasks, create or update tasks, and mark tasks complete (`TasksService.ts`; Tasks allowlist entries).                                                    | `tasks.readonly` cannot perform create/update/complete actions; Google provides no narrower Tasks write scope.                                                                                                                                      |

Identity scopes associate the grant with the signed-in Google account and let
Stella display/verify the connected account. They do not grant Workspace
content access.

## Minimum-scope caveats to retain in review materials

- **Calendar:** full `calendar` matches the reviewed six-scope bundle and all
  current calls, but it is broader than a possible combination of
  `calendar.events`, `calendar.calendarlist.readonly`, and a free/busy-capable
  scope such as `calendar.events.freebusy`. The previous two-scope backend pair
  was not sufficient because `CalendarService` calls `freebusy.query`. Test the
  three-scope alternative before claiming full Calendar is uniquely necessary.
- **Drive:** full `drive` is required by the current arbitrary-file workflow if
  represented as one scope, but it grants capabilities that are not allowlisted.
  Validate whether a combination of read-only content, metadata-write, and
  app-created-file scopes can cover folder creation plus arbitrary rename before
  claiming no narrower combination exists.
- **Docs/Sheets overlap:** full Drive can authorize some Docs and Sheets API
  operations. The product-specific scopes make service requirements explicit,
  but reviewers may consider them overlapping when Drive is always requested.
  Test removal of Docs/Sheets scopes if Drive remains mandatory, or document the
  service-specific consent and readiness reason for retaining them.
- `gmail.modify` and full `drive` are restricted scopes. Confirm whether the
  deployed data path triggers Google's restricted-scope security assessment.

## Verification demo checklist

1. Show the OAuth consent screen and the complete scope disclosure without
   hiding or truncating requested permissions.
2. Connect the clearly labeled **Google Workspace** shared bundle and confirm
   the account identity shown by Stella.
3. Demonstrate at least one real user-initiated action per scope: Gmail label
   modification, Calendar write and free/busy lookup, Doc write, arbitrary Drive
   search/download/rename, Sheet write, and Task creation/completion.
4. Show that a simulated or approved legacy partial grant is prompted for the
   complete union and remains connected after the upgrade.
5. Show disconnect/revocation and the user-facing privacy policy/data handling
   disclosures. Never include client secrets, access tokens, refresh tokens, or
   unredacted private user content in evidence captures.

Official policy and scope references:

- <https://support.google.com/cloud/answer/13464321>
- <https://developers.google.com/workspace/gmail/api/auth/scopes>
- <https://developers.google.com/workspace/calendar/api/auth>
- <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- <https://developers.google.com/workspace/docs/api/auth>
- <https://developers.google.com/workspace/sheets/api/scopes>
- <https://developers.google.com/workspace/tasks/auth>
