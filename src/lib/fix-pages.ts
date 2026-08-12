// Pain-point landing pages — /fix/<slug>.
//
// One entry per pain cluster from the pain-point knowledge graph
// (launch-order clusters 1–25 shipped first). Each page targets people
// searching for a specific computer problem who don't realize an agent can
// just fix it, so the copy mirrors the searcher's own words — the `symptoms`
// strings are real search queries, kept verbatim for ad relevance.
//
// Adding a page = appending one entry here. The template at
// `src/app/fix/[slug]/page.tsx` and the sitemap pick it up automatically.

export type FixPage = {
  /** URL slug — /fix/<slug>. Keep it close to the searcher's own words. */
  slug: string;
  /** Cluster name in the knowledge graph (internal reference only). */
  cluster: string;
  /** Small mono eyebrow above the headline, e.g. "Fix it with Stella · Gaming". */
  eyebrow: string;
  /** <title> without the " | Stella" suffix the layout template appends. */
  metaTitle: string;
  metaDescription: string;
  /** Big serif H1; `headlineAccent` renders as the italic blue span. */
  headline: string;
  headlineAccent: string;
  lede: string;
  /** Real searches this page answers, shown verbatim ("Sound familiar?"). */
  symptoms: string[];
  /** Example of what you'd actually type to Stella. */
  prompt: string;
  /** What Stella concretely does on your computer for this problem. */
  steps: string[];
  /** Honest scope — what this fix is and isn't. Never overpromise. */
  scope: string;
  ctaHeadline: string;
};

export const FIX_PAGES: FixPage[] = [
  {
    slug: "comfyui-broken-after-update",
    cluster: "Local AI tooling breakage — ComfyUI / Stable Diffusion",
    eyebrow: "Fix it with Stella · Local AI tools",
    metaTitle: "ComfyUI broken after an update? Stella fixes it",
    metaDescription:
      "ComfyUI won't start, custom nodes failing to import, torch/CUDA mismatch, xformers errors — Stella reads the actual error and repairs your setup without a reinstall. Free to start.",
    headline: "ComfyUI broke again.",
    headlineAccent: "Stella fixes it.",
    lede: "Torch/CUDA mismatch, custom nodes that won't import, xformers errors after every update. Tell Stella what happened — it reads the actual error, repairs your environment, and keeps your workflows. Your setup, fixed — not replaced.",
    symptoms: [
      "comfyui broken after update",
      "comfyui missing custom nodes fix",
      "comfyui torch cuda version mismatch",
      "comfyui failed to import custom node",
      "fix comfyui without reinstalling",
      "a1111 xformers error fix",
    ],
    prompt:
      "ComfyUI won't start since I updated it — the console says 'Failed to import custom node' and something about torch and CUDA versions.",
    steps: [
      "Reads the startup log and the real error, not a forum guess",
      "Checks your torch / CUDA / xformers versions and installs a matching set",
      "Reinstalls or pins the custom nodes that failed to import",
      "Relaunches ComfyUI to confirm it loads — workflows and models untouched",
    ],
    scope:
      "Stella repairs the environment — Python, torch, nodes, dependencies — right on your machine, and shows you every command it runs. If a custom node is genuinely abandoned and incompatible with your ComfyUI version, Stella says so and quarantines it instead of pretending.",
    ctaHeadline: "Stop reinstalling ComfyUI.",
  },
  {
    slug: "stop-fake-virus-popups",
    cluster: "Browser notification spam & fake 'virus alert' pop-ups",
    eyebrow: "Fix it with Stella · Browser cleanup",
    metaTitle: "Stop fake virus alert pop-ups and notification spam",
    metaDescription:
      "Fake 'your PC is infected' pop-ups are browser notifications, not a virus. Stella opens your browser settings, revokes every rogue site's permission, and blocks new ones. Free to start.",
    headline: "Those “virus” pop-ups?",
    headlineAccent: "Not a virus. Gone.",
    lede: "That “Your PC is infected” alert in the corner of your screen is almost always a browser notification a website tricked you into allowing — not malware. Stella opens your browser's settings, revokes every rogue site's permission, and flips the default so no site can ask again.",
    symptoms: [
      "getting virus alert pop ups in bottom right corner of screen",
      "mcafee virus alert popup keeps coming up not real",
      "windows keeps showing your computer is infected notification",
      "how to stop chrome notifications from websites",
      "fake windows defender popup wont go away",
      "block all sites from sending notifications edge",
    ],
    prompt:
      "I keep getting 'McAfee virus alert' pop-ups in the bottom-right corner and I don't even have McAfee. Make them stop.",
    steps: [
      "Opens Chrome, Edge, or Firefox notification settings for you",
      "Revokes every suspicious site's notification permission",
      "Deletes the offending sites' data so they can't come back",
      "Sets the default to 'don't allow' so nothing new can start nagging",
    ],
    scope:
      "This fixes the browser-notification scam — which is what these pop-ups almost always are. It is not an antivirus. If something on your machine looks like actual malware, Stella will say so and help you investigate rather than pretend a scan happened.",
    ctaHeadline: "Kill the pop-ups in one ask.",
  },
  {
    slug: "c-drive-full",
    cluster: "'C drive full' / storage & junk-file panic",
    eyebrow: "Fix it with Stella · Storage",
    metaTitle: "C drive full? Don't guess what's safe to delete",
    metaDescription:
      "Disk full and can't install updates? Stella scans what's taking up space, explains what's safe to delete and why, and cleans up only what you approve. No cleaner-app roulette.",
    headline: "C: drive full?",
    headlineAccent: "Don't guess what to delete.",
    lede: "Instead of a scammy “cleaner” app, get an assistant that actually looks. Stella scans what's taking up space, shows you what's safe to remove and why — temp files, old installers, duplicate downloads — and cleans up only what you approve.",
    symptoms: [
      "c drive full what can i delete",
      "what is taking up space on my pc",
      "my computer says storage full",
      "safe to delete windows temp files",
      "disk full can't install update",
      "duplicate file finder",
    ],
    prompt:
      "My C drive is full and Windows can't install its update. Figure out what's eating the space and what I can actually delete.",
    steps: [
      "Scans the drive and shows you the biggest space hogs, explained in plain English",
      "Separates safe-to-delete (temp files, caches, old installers) from your actual stuff",
      "Finds duplicate files and old downloads you forgot about",
      "Cleans up what you approve and frees enough room for the update to install",
    ],
    scope:
      "Stella shows you the plan before touching anything — every file it wants to remove, and why. Nothing is deleted without your OK. It's an assistant that looks, not a cleaner that guesses.",
    ctaHeadline: "Get your disk space back, safely.",
  },
  {
    slug: "merge-excel-files",
    cluster: "Spreadsheet merge & clean drudgery",
    eyebrow: "Fix it with Stella · Spreadsheets",
    metaTitle: "Combine multiple Excel or CSV files into one clean sheet",
    metaDescription:
      "Merge a folder of Excel and CSV files into one clean spreadsheet — columns aligned, rows deduped — without learning Power Query. Tell Stella what the final sheet should look like.",
    headline: "Thirty spreadsheets,",
    headlineAccent: "one clean sheet.",
    lede: "Don't learn Power Query. Don't record a macro. Tell Stella what the final sheet should look like, and it combines the files, fixes the columns, dedupes the rows, and hands you one clean workbook — then does it again next week when the new files land.",
    symptoms: [
      "combine multiple excel files into one",
      "merge csv files into one spreadsheet",
      "consolidate excel sheets without copy paste",
      "clean up messy excel data",
      "automate weekly excel report",
    ],
    prompt:
      "Merge every CSV in this folder into one spreadsheet — same columns, no duplicate rows, dates formatted consistently.",
    steps: [
      "Reads every file in the folder, whatever the format",
      "Aligns mismatched columns and headers into the layout you asked for",
      "Dedupes rows and fixes types — dates as dates, numbers as numbers",
      "Writes one clean workbook, and can repeat the whole job on next week's files",
    ],
    scope:
      "You get a real .xlsx on your machine, built locally from your files — open it in Excel and check it. If a column mapping is ambiguous, Stella asks instead of guessing.",
    ctaHeadline: "Stop copy-pasting between workbooks.",
  },
  {
    slug: "bank-statement-to-excel",
    cluster: "Bank statements & receipts -> spreadsheet",
    eyebrow: "Fix it with Stella · Finance admin",
    metaTitle: "Convert bank statement PDFs to Excel — on your machine",
    metaDescription:
      "Stop retyping bank statements. Drop the PDFs on Stella — every transaction extracted, categorized, and filed into a clean spreadsheet. Statements never leave your computer.",
    headline: "Bank statement PDFs,",
    headlineAccent: "typed for you.",
    lede: "Stop retyping transactions line by line. Drop the PDFs on Stella — it extracts every transaction, categorizes them, and files a clean spreadsheet. And because Stella runs on your computer, your statements never get uploaded to some converter website.",
    symptoms: [
      "convert bank statement pdf to excel",
      "bank statement to csv free",
      "extract transactions from pdf statement",
      "get transactions from chase pdf statement",
      "scan receipts into quickbooks automatically",
    ],
    prompt:
      "Turn these twelve statements into one spreadsheet of transactions — date, description, amount, category — newest first.",
    steps: [
      "Reads each statement PDF, including scanned ones",
      "Extracts every transaction into typed columns — dates, amounts, descriptions",
      "Categorizes spending the way you ask (or suggests categories)",
      "Saves the .xlsx or .csv exactly where you want it, ready for Excel or your bookkeeper",
    ],
    scope:
      "Everything runs locally — your statements never leave your machine, unlike web converters. Messy scans can need a quick review pass: Stella flags any row it wasn't sure about instead of silently guessing.",
    ctaHeadline: "Never retype a statement again.",
  },
  {
    slug: "website-data-to-excel",
    cluster: "Copy-pasting data off many web pages into a spreadsheet by hand",
    eyebrow: "Fix it with Stella · Web to spreadsheet",
    metaTitle: "Get data from web pages into Excel without copy-paste",
    metaDescription:
      "Describe the pages and the columns you want. Stella opens them in your browser, walks every page of results, and hands you a clean, deduped spreadsheet with real numbers.",
    headline: "Stop copy-pasting",
    headlineAccent: "web pages into Excel.",
    lede: "Describe the pages and the columns you want. Stella opens them in your own browser, walks through every page of results, and hands you a clean, deduped spreadsheet — with numbers that are actually numbers, not text that breaks your formulas.",
    symptoms: [
      "how to copy data from website to excel fast",
      "copy table from website to excel columns merged",
      "extract data from multiple web pages to spreadsheet",
      "scrape website into excel without coding",
      "pull data from 100 web pages into csv",
      "website table to excel keeps as text not numbers",
    ],
    prompt:
      "Go through all 40 pages of this directory and build me a spreadsheet with name, city, phone, and website for every listing.",
    steps: [
      "Opens the site in your browser and pages through every listing",
      "Pulls exactly the columns you described from each page",
      "Fixes the classic mess — merged columns, text-that-should-be-numbers, duplicates",
      "Writes a tidy CSV or Excel file to your computer while you watch it work",
    ],
    scope:
      "Stella works in your own browser with your own logins, so it sees what you see. Sites that aggressively block automation can slow things down — Stella tells you when a site is fighting back instead of quietly returning half a table.",
    ctaHeadline: "Describe the sheet. Skip the copy-paste.",
  },
  {
    slug: "sims-4-mods-broken",
    cluster: "Game-mod breakage after patches — Sims 4",
    eyebrow: "Fix it with Stella · Gaming",
    metaTitle: "Sims 4 mods broken after the update? Fixed",
    metaDescription:
      "Sims 4 not loading after a patch? Stella checks which mods actually broke, cross-references the community lists, pulls updates, and gets your game loading — without nuking your Mods folder.",
    headline: "Sims patch broke your mods.",
    headlineAccent: "Again.",
    lede: "Don't nuke the Mods folder. Stella checks which of your mods actually broke, cross-references the community broken-mods lists, pulls the updated versions, and gets your game loading again — keeping everything that still works.",
    symptoms: [
      "sims 4 mods broken after update",
      "sims 4 not loading after patch mods",
      "which sims 4 mods are broken",
      "sims 4 last exception error fix",
      "skyrim keeps crashing modded fix",
    ],
    prompt:
      "Sims 4 won't load after today's patch. Figure out which of my mods broke and fix what can be fixed.",
    steps: [
      "Scans your Mods folder and reads the lastException errors",
      "Cross-references the community's broken/updated mod lists for this patch",
      "Downloads updated versions in your browser and swaps them in",
      "Moves only the truly broken mods aside, then launches to confirm the game loads",
    ],
    scope:
      "If a mod's creator hasn't shipped an update for the new patch yet, no tool can fix that mod today. Stella identifies it, sets it aside so the rest of your game works, and can check again for the update whenever you ask.",
    ctaHeadline: "Patch day doesn't have to hurt.",
  },
  {
    slug: "minecraft-modpack-crash",
    cluster: "Minecraft modpack won't launch — Forge/Fabric crash, Java version mismatch",
    eyebrow: "Fix it with Stella · Gaming",
    metaTitle: "Minecraft modpack crashing on launch? Stella reads the log",
    metaDescription:
      "Instant crash is almost always the wrong Java, RAM allocation, or one bad mod. Stella reads the crash report, installs the right Java, sets the RAM, and pulls the conflicting mod.",
    headline: "Modpack crashes on launch?",
    headlineAccent: "The log knows why.",
    lede: "An instant crash is almost always the wrong Java version, too little RAM, or one conflicting mod. Stella reads the crash report — the whole thing — installs the Java your pack actually needs, sets the allocation, and pulls the mod that's breaking the load.",
    symptoms: [
      "minecraft modpack crash on launch fix",
      "minecraft forge exit code 1",
      "minecraft wrong java version fix",
      "how much ram to allocate minecraft modpack",
      "curseforge modpack not launching",
      "optifine crash with mods",
    ],
    prompt:
      "My CurseForge modpack crashes with 'exit code 1' the second I hit play. Read the crash report and fix it.",
    steps: [
      "Opens the crash-reports folder and reads the actual error, stack trace and all",
      "Installs the exact Java version your pack needs and points the launcher at it",
      "Sets a sane RAM allocation for the pack size",
      "Finds the conflicting mod, removes or updates it, and relaunches to confirm",
    ],
    scope:
      "This is deterministic file-and-config work on your machine, and Stella shows its reasoning from the crash log. If the pack itself shipped broken, Stella can roll you back to the last version that launched.",
    ctaHeadline: "Get back in the game.",
  },
  {
    slug: "obs-black-screen",
    cluster: "OBS Studio broken after update — black screen / no capture / audio desync",
    eyebrow: "Fix it with Stella · Streaming",
    metaTitle: "OBS black screen after an update? No reinstall needed",
    metaDescription:
      "OBS display capture black after an update? Stella reads the OBS log, switches the capture method or GPU flag, re-grants permissions, and confirms capture works — scenes intact.",
    headline: "OBS showing a black screen?",
    headlineAccent: "Your scenes are fine.",
    lede: "After an update, OBS usually just needs a capture-method switch, a GPU flag, or a screen-recording permission re-granted. Stella reads the OBS log, finds what flipped, fixes it, and confirms capture is working — no reinstall, scenes and sources intact.",
    symptoms: [
      "obs black screen after update fix",
      "obs display capture black",
      "obs not capturing screen",
      "obs game capture not working",
      "obs stopped recording after update",
      "obs audio out of sync fix",
    ],
    prompt:
      "OBS is just a black screen since it updated — display capture shows nothing. Fix it without losing my scenes.",
    steps: [
      "Reads the OBS log to see what the update actually changed",
      "Switches the capture method or GPU preference to the one that works on your setup",
      "Re-grants the macOS screen-recording permission or fixes the Windows graphics setting",
      "Re-adds the broken source if needed and runs a test capture to confirm",
    ],
    scope:
      "This is config surgery on your machine — capture methods, GPU flags, permissions. If the new OBS build itself is broken for your hardware, Stella rolls you back to the previous version with your scene collection untouched.",
    ctaHeadline: "Back to recording tonight.",
  },
  {
    slug: "missing-vst-plugins",
    cluster: "DAW plugins vanished / VST scan crashes — FL Studio, Ableton, Reaper",
    eyebrow: "Fix it with Stella · Music production",
    metaTitle: "Plugins missing after a DAW update? They're still there",
    metaDescription:
      "FL Studio, Ableton, or Reaper lost your plugins? It's almost always a search-path or scan problem. Stella fixes the VST paths, quarantines the crasher, and rebuilds your plugin database.",
    headline: "Half your plugins vanished?",
    headlineAccent: "They're still there.",
    lede: "When FL Studio, Ableton, or Reaper loses plugins after an update, it's nearly always a search-path or scan problem — not lost files. Stella finds where your VSTs actually live, fixes the paths, quarantines the one plugin crashing the scan, and rebuilds your plugin database.",
    symptoms: [
      "fl studio plugins missing after update",
      "ableton not finding vst plugins",
      "reaper vst scan crash",
      "daw plugin not showing up",
      "vst3 folder path windows",
      "missing plugins after reinstall daw",
    ],
    prompt:
      "Ableton stopped seeing half my VSTs after the update. Find them and get them back in the browser.",
    steps: [
      "Finds where your VST2/VST3 plugins are actually installed",
      "Fixes the DAW's plugin search paths to include all of them",
      "Rescans, and quarantines the plugin that's crashing the scan",
      "Rebuilds the plugin database and verifies the full list shows in your browser",
    ],
    scope:
      "This is file-and-config work Stella does reliably. If a plugin's own license or activation broke, that last step needs your vendor sign-in — Stella takes you right up to it and tells you exactly which plugin needs it.",
    ctaHeadline: "Back to the beat, not the plugin manager.",
  },
  {
    slug: "game-mods-broken-after-patch",
    cluster: "Patch broke my single-player mods (BG3, Cyberpunk, Stardew)",
    eyebrow: "Fix it with Stella · Gaming",
    metaTitle: "Mods broken after a game update? Rebuilt in minutes",
    metaDescription:
      "BG3, Cyberpunk, Stardew — every patch breaks mods. Stella updates your mod manager, pulls current mod versions from Nexus, clears orphaned files, rebuilds the load order, and relaunches.",
    headline: "Game update killed your mods.",
    headlineAccent: "Rebuild in minutes.",
    lede: "BG3, Cyberpunk, Stardew — every patch breaks something. Stella updates the mod manager itself (BG3MM, SMAPI, RED4ext), pulls current mod versions from Nexus in your browser, clears out orphaned files, rebuilds the load order, and relaunches to confirm a clean start.",
    symptoms: [
      "bg3 mods not working after patch",
      "baldur's gate 3 crashes on launch with mods",
      "cyberpunk 2077 mods not working after update",
      "smapi not launching after stardew update",
      "red4ext archivexl tweakxl not working",
      "fix mods after game patch",
    ],
    prompt:
      "Cyberpunk mods stopped working after the update — update whatever needs updating and get my load order working again.",
    steps: [
      "Updates the mod manager and framework mods first — BG3MM, SMAPI, RED4ext, ArchiveXL",
      "Pulls the current version of each mod from Nexus in your own browser session",
      "Deletes orphaned files and migrates mods into the folders the new patch expects",
      "Rebuilds the load order and relaunches the game to confirm it starts clean",
    ],
    scope:
      "If a specific mod's author hasn't updated it for the new patch yet, nothing can fix that mod today. Stella detects it and quarantines it so everything else runs — then checks for the update again whenever you ask.",
    ctaHeadline: "Every patch. Same fix. Zero dread.",
  },
  {
    slug: "onedrive-moved-my-files",
    cluster: "OneDrive/iCloud 'moved my files' & sync chaos",
    eyebrow: "Fix it with Stella · Files & sync",
    metaTitle: "OneDrive moved your files? Get them back where they were",
    metaDescription:
      "Desktop files disappeared into OneDrive? Stella untangles the folder redirection, restores real local copies, and turns off the backup switch that caused it — without losing anything.",
    headline: "OneDrive hijacked your Desktop?",
    headlineAccent: "Get your files back.",
    lede: "Windows quietly redirected your Desktop and Documents into OneDrive, and now nothing is where it was. Stella untangles the folder redirection, restores real local copies of your files, and turns off the “backup” switch that did it — in the right order, so nothing gets lost.",
    symptoms: [
      "onedrive moved my files how to get them back",
      "desktop files disappeared windows 11",
      "turn off onedrive folder backup safely",
      "documents folder now in onedrive fix",
      "icloud removed files from my mac",
    ],
    prompt:
      "My desktop files disappeared and everything says it's in OneDrive now. Put it back the way it was without losing anything.",
    steps: [
      "Finds where your files actually live right now — local, cloud-only, or both",
      "Downloads real local copies of anything that's cloud-only before changing settings",
      "Turns off the folder backup / redirection safely, in the order that loses nothing",
      "Points Desktop and Documents back to your local folders and verifies files open",
    ],
    scope:
      "The order of operations is the whole game here — turning off sync at the wrong moment is how files vanish. Stella checks what's local before touching settings, and walks the same careful path for iCloud's 'optimize storage' on Mac.",
    ctaHeadline: "Your files, back where you left them.",
  },
  {
    slug: "organize-downloads-folder",
    cluster: "'My Downloads folder is a swamp' — organize thousands of loose files",
    eyebrow: "Fix it with Stella · Files",
    metaTitle: "Organize a Downloads folder with thousands of files",
    metaDescription:
      "Stella reads what's in the swamp, shows you a plan — where every file will go — then sorts thousands of files into clean folders in one undoable pass. Nothing deleted without approval.",
    headline: "4,000 files in Downloads?",
    headlineAccent: "Sorted. Plan first.",
    lede: "Stella reads what's actually in there, proposes a folder structure — by type, date, or project — and shows you exactly where every file will go before anything moves. Then one clean pass, with a record of every move so it's undoable.",
    symptoms: [
      "organize downloads folder automatically",
      "clean up messy desktop files",
      "sort files into folders by type",
      "organize thousands of files",
      "sort files by date into folders",
      "declutter my computer files",
    ],
    prompt:
      "Clean up my Downloads folder — group things by what they are, keep the last month easy to reach, archive the rest.",
    steps: [
      "Scans the folder and figures out what things actually are — not just extensions",
      "Shows you a dry-run plan: every file and where it's going",
      "Sorts into clean folders by type, date, or project — your call",
      "Flags duplicates and old installers for deletion, but only deletes with your OK",
    ],
    scope:
      "You see the full plan before a single file moves, and Stella keeps a record of every move so the pass is reversible. Nothing is deleted without your explicit approval.",
    ctaHeadline: "Drain the swamp in one pass.",
  },
  {
    slug: "plex-not-matching",
    cluster: "Rename media so Plex/Jellyfin actually matches it (wrong poster / not showing)",
    eyebrow: "Fix it with Stella · Media server",
    metaTitle: "Plex matching the wrong movie? Fix the naming, once",
    metaDescription:
      "Wrong posters and missing episodes are almost always naming. Stella renames your whole library to Plex/Jellyfin's exact convention, tags IMDb IDs, and triggers a rescan.",
    headline: "Plex grabbing the wrong poster?",
    headlineAccent: "It's the filenames.",
    lede: "Wrong posters, movies that won't show up, episodes out of order — it's almost always naming. Stella renames and re-folders your whole library to Plex/Jellyfin's exact convention — Title (Year) {imdb-tt…}, proper Season/Episode structure — then triggers a rescan so every match lands.",
    symptoms: [
      "plex not matching my movies wrong poster",
      "jellyfin wrong metadata rename files",
      "plex file naming convention movies tv",
      "how to name tv episodes for plex",
      "bulk rename movies for jellyfin",
      "plex won't recognize my files folder structure",
    ],
    prompt:
      "Plex thinks half my movies are different movies and some shows won't appear at all. Fix the names and folders so everything matches.",
    steps: [
      "Scans your library and works out which files Plex is mismatching, and why",
      "Renames everything to the exact convention, including IMDb/TMDB IDs where needed",
      "Restructures show folders into proper Season/Episode layout",
      "Triggers a library rescan and verifies the matches came back right",
    ],
    scope:
      "Truly obscure titles that aren't in TMDB/IMDb can't auto-match anywhere — Stella flags those few for a manual pick instead of guessing, and fixes everything else.",
    ctaHeadline: "Every poster right. Every episode found.",
  },
  {
    slug: "car-usb-music",
    cluster: "My car won't play music off the USB stick",
    eyebrow: "Fix it with Stella · Everyday tech",
    metaTitle: "Car won't play music from USB? It's the stick, not the radio",
    metaDescription:
      "Car stereo says no supported files? Stella reformats the drive the way head units expect, converts the files your radio rejects, fixes tags, and folders albums so they play in order.",
    headline: "Car won't read the USB?",
    headlineAccent: "It's the stick, not the radio.",
    lede: "Head units are picky: drive format, file types, folder counts, name order. Stella reformats the stick the way your stereo expects, converts the files it rejects (FLAC → MP3), fixes the tags, and folders everything with numbered names so albums play in order.",
    symptoms: [
      "car won't read music from usb",
      "how to format usb for car stereo",
      "car stereo not playing songs in order from usb",
      "car radio says no support usb music",
      "car won't recognize flac files usb",
      "convert music for car usb mp3",
    ],
    prompt:
      "My car says 'no supported files' on my music USB. Make me a stick it will actually play, with albums in order.",
    steps: [
      "Reformats the drive to FAT32/exFAT — what head units actually read",
      "Converts FLAC/OGG/M4A files to MP3s your radio accepts",
      "Normalizes the ID3 tags so titles and artists display right",
      "Builds numbered folders with leading-zero filenames so albums play in order, under the per-folder limits",
    ],
    scope:
      "If the USB port or head unit is genuinely dead hardware, software can't fix that — but the overwhelming majority of 'no supported files' errors are format and file-type problems, which this solves end to end.",
    ctaHeadline: "Every song, in order, first try.",
  },
  {
    slug: "externally-managed-environment",
    cluster: "Python environment hell outside AI — 'externally-managed-environment', venv/pip/conda conflicts",
    eyebrow: "Fix it with Stella · Dev environment",
    metaTitle: "'externally-managed-environment' pip error, fixed",
    metaDescription:
      "pip refusing to install, conda vs pip conflicts, 'No module named' after installing — Stella sets up the right virtual environment, installs what your script needs, and runs it.",
    headline: "“externally-managed-environment”?",
    headlineAccent: "Just run the script.",
    lede: "pip refusing to install, conda and pip fighting, “No module named…” right after a successful install. Stella sets up the right virtual environment, installs what your script actually needs, and runs it — no --break-system-packages roulette.",
    symptoms: [
      "error externally-managed-environment pip how to fix",
      "pip install this environment is externally managed",
      "conda and pip conflict broke my python",
      "python command not found after installing mac",
      "pip install works but python can't find the module",
      "no module named even after pip install fix",
    ],
    prompt:
      "pip says 'this environment is externally managed' and my script won't run. Set it up properly and run it.",
    steps: [
      "Reads the error and your script to see what's actually needed",
      "Creates a proper virtual environment (venv, uv, or pipx — whatever fits)",
      "Installs the requirements into it, untangling any pip/conda conflicts",
      "Fixes PATH / wrong-python issues and runs the script to confirm it works",
    ],
    scope:
      "Stella untangles the environment properly instead of reaching for force flags, and shows you every command it runs — so you also end up with a setup that keeps working tomorrow.",
    ctaHeadline: "Python problems, handled.",
  },
  {
    slug: "vcruntime140-dll-missing",
    cluster: "Missing DLL / Visual C++ runtime errors on game launch",
    eyebrow: "Fix it with Stella · Gaming",
    metaTitle: "VCRUNTIME140.dll missing? Skip the sketchy DLL sites",
    metaDescription:
      "Game won't launch with a missing DLL error? Stella reads the exact error, installs the right Microsoft Visual C++ and DirectX runtimes, repairs system files, and relaunches your game.",
    headline: "“VCRUNTIME140.dll is missing”?",
    headlineAccent: "Skip the sketchy sites.",
    lede: "Don't download DLLs from random websites. Stella reads the exact error, installs the correct Microsoft Visual C++ and DirectX runtimes — both 32- and 64-bit, straight from Microsoft — repairs corrupted system files, and relaunches your game to confirm it opens.",
    symptoms: [
      "vcruntime140.dll missing game won't launch",
      "msvcp140.dll not found fix",
      "the program can't start because vcruntime140.dll is missing",
      "0xc000007b error game won't start",
      "d3dx9_43.dll missing game",
      "game won't open dll error windows 11",
    ],
    prompt:
      "My game won't launch — 'The code execution cannot proceed because VCRUNTIME140.dll was not found.' Fix it.",
    steps: [
      "Identifies the exact runtime your error string points to",
      "Downloads the right Visual C++ / DirectX redistributables from Microsoft — never a DLL site",
      "Installs both the 32-bit and 64-bit versions, which is the step most guides miss",
      "Runs SFC/DISM if system files are corrupt, then relaunches the game to confirm",
    ],
    scope:
      "The rare case where deep OS corruption is underneath needs a Windows repair install — if you're in that minority, Stella tells you plainly instead of looping through fixes that won't take.",
    ctaHeadline: "Launch the game, not a DLL hunt.",
  },
  {
    slug: "path-too-long",
    cluster: "Files you can't delete, move, or rename ('path too long')",
    eyebrow: "Fix it with Stella · Windows",
    metaTitle: "'Path too long' — delete the folder Windows won't",
    metaDescription:
      "Windows won't delete, move, or rename it because the path is too long or the file is locked. Stella uses the IT-pro tricks — long-path mode, robocopy, ownership — safely, for you.",
    headline: "“Path too long.”",
    headlineAccent: "Deleted anyway.",
    lede: "Windows won't delete, move, or rename it because the path is too long, the name is invalid, or something has the file locked. Stella uses the same tricks IT pros use — long-path mode, robocopy, taking ownership, releasing the locking process — without you touching a command prompt.",
    symptoms: [
      "cannot delete file path too long",
      "source path too long cannot delete folder",
      "how to delete a folder that won't delete",
      "destination path too long windows 10",
      "undeletable folder windows fix",
      "can't rename file path too long",
    ],
    prompt:
      "There's a folder Windows refuses to delete — 'source path too long.' Get rid of it.",
    steps: [
      "Works out why it's stuck — path length, a locking process, or permissions",
      "Applies the long-path prefix or empties the tree with robocopy",
      "Takes ownership when it's a permissions problem",
      "Finds and releases the process holding the file, then confirms it's gone",
    ],
    scope:
      "This is a Windows-specific fix for a Windows-specific problem. For anything owned by the system, Stella shows you what it's about to do before doing it — stubborn files, not reckless deletes.",
    ctaHeadline: "That folder is done being stubborn.",
  },
  {
    slug: "git-disaster-recovery",
    cluster: "Git disaster recovery — 'oh sh*t, git' (undo, merge conflicts, detached HEAD, wrong branch, lost work)",
    eyebrow: "Fix it with Stella · Dev tools",
    metaTitle: "Wrecked your git repo? Your work is still in there",
    metaDescription:
      "Wrong branch, hard reset, detached HEAD, merge conflict soup — git almost never loses work. Stella reads your repo's real state, finds the safe recovery path, and runs it for you.",
    headline: "Wrecked your git repo?",
    headlineAccent: "Your work is still in there.",
    lede: "Committed to the wrong branch, hard-reset your changes away, stuck in detached HEAD, staring at conflict markers — git almost never actually loses work. Stella reads your repo's real state — status, log, reflog, stashes — finds the safe recovery path, and runs it. No more pasting reset commands you don't understand.",
    symptoms: [
      "how do i undo my last git commit",
      "git accidentally committed to wrong branch how to fix",
      "git detached head how to get back",
      "git reset hard lost my changes recover",
      "how to undo git pull that broke everything",
      "i deleted a branch how do i get my commits back git",
    ],
    prompt:
      "I ran git reset --hard and lost a day of work. Get it back.",
    steps: [
      "Reads git status, log, and reflog to see what actually happened",
      "Finds your 'lost' commits and stashes — they're almost always recoverable",
      "Runs the exact recovery: reset, cherry-pick, restore, or branch resurrection",
      "Walks merge conflicts with you file by file, then verifies the history looks right",
    ],
    scope:
      "Stella explains the recovery plan before running it and won't force-push or rewrite shared history without asking. Your repo, your call — it just knows the way out.",
    ctaHeadline: "Un-wreck the repo.",
  },
  {
    slug: "fix-music-tags",
    cluster: "Fix a messy music library — ID3 tags, album art, rename & folder structure",
    eyebrow: "Fix it with Stella · Music library",
    metaTitle: "Fix MP3 tags and album art for your whole library",
    metaDescription:
      "Stella fingerprints every track, pulls correct titles, albums, and artwork from MusicBrainz, and files everything into clean Artist/Album folders — thousands of songs in one pass.",
    headline: "Music library a mess?",
    headlineAccent: "Every tag. Every cover.",
    lede: "“Track 01” by “Unknown Artist”, forever. Stella fingerprints each file by its audio, pulls the right titles, albums, and artwork from MusicBrainz, embeds it all, and renames everything into clean Artist/Album folders — thousands of songs in one pass.",
    symptoms: [
      "fix mp3 tags for entire music library",
      "add album art to all my songs automatically",
      "organize music library by artist album folder",
      "batch rename mp3 files from metadata",
      "auto tag music collection musicbrainz",
      "missing album artwork mp3 bulk fix",
    ],
    prompt:
      "Fix the tags and album art for my whole music folder and organize it into Artist/Album folders.",
    steps: [
      "Fingerprints each track by its actual audio, so wrong filenames don't matter",
      "Pulls canonical titles, albums, years, and track numbers from MusicBrainz",
      "Embeds proper cover art in every file",
      "Renames and files everything into a clean Artist/Album structure",
    ],
    scope:
      "Rare, bootleg, or live recordings may not exist in any database — Stella queues those for a quick confirm instead of mis-tagging them, and handles everything else automatically.",
    ctaHeadline: "A library that finally looks right.",
  },
  {
    slug: "windows-start-menu-broken",
    cluster: "Windows 11 Start menu / Search dead after an update",
    eyebrow: "Fix it with Stella · Windows",
    metaTitle: "Windows 11 Start menu not working after update? No reset",
    metaDescription:
      "Start button dead, can't type in search? Stella restarts the right services, re-registers the Start/Search packages, repairs system files, and confirms it works — no factory reset.",
    headline: "Start menu dead after an update?",
    headlineAccent: "No reset required.",
    lede: "Can't click Start, can't type in the search bar — and every guide ends with “reset your PC.” Stella restarts the right services, re-registers the Start and Search packages, repairs corrupt system files, rebuilds the index, and confirms search works. No factory reset, no data loss.",
    symptoms: [
      "windows 11 start menu not working after update",
      "cant type in windows search bar",
      "windows 11 search not working fix",
      "start button not working windows 11",
      "reregister start menu powershell",
      "windows update broke start menu",
    ],
    prompt:
      "Windows 11 search won't accept typing and the Start button does nothing since the update. Fix it without a reset.",
    steps: [
      "Restarts explorer.exe and ctfmon — the two-minute fix that often works",
      "Restarts and re-enables the Windows Search service",
      "Re-registers the Start/Search app packages via PowerShell",
      "Runs SFC/DISM for corrupt system files, rebuilds the search index, and rolls back the offending update if that's the real culprit",
    ],
    scope:
      "Everything happens on your machine with every step visible. If the only real fix is rolling back the specific update that broke it, Stella does that and tells you which one it was.",
    ctaHeadline: "A working Start menu, not a factory reset.",
  },
  {
    slug: "download-email-attachments",
    cluster: "Pull every attachment out of a buried inbox and sort it",
    eyebrow: "Fix it with Stella · Email",
    metaTitle: "Download all Gmail attachments at once, sorted into folders",
    metaDescription:
      "Gmail only saves attachments one email at a time. Stella works in your own logged-in inbox, downloads every matching PDF, receipt, and photo, and files them by sender and month.",
    headline: "Every attachment,",
    headlineAccent: "out of the inbox at once.",
    lede: "Gmail only lets you save attachments one email at a time — there is no whole-mailbox button. Stella works inside your own logged-in inbox, searches for what you describe, downloads every matching PDF, receipt, and photo, removes duplicates, and files them into folders on your computer.",
    symptoms: [
      "download all attachments from gmail at once",
      "gmail save all attachments to folder bulk",
      "how to download every pdf from gmail",
      "bulk download email attachments outlook",
      "save all invoices from gmail to computer",
      "extract all photos people emailed me",
    ],
    prompt:
      "Download every invoice PDF anyone has ever emailed me and sort them into folders by year.",
    steps: [
      "Runs the mail search you describe — sender, file type, date range, label",
      "Opens each matching email and downloads every attachment",
      "Dedupes filenames so 'invoice.pdf' × 40 doesn't overwrite itself",
      "Files everything into folders by sender, month, or type — your choice",
    ],
    scope:
      "Stella uses your own browser and your own logged-in account, and the files land straight on your disk — nothing is uploaded anywhere. A huge inbox just takes a while; Stella keeps working in the background while you do something else.",
    ctaHeadline: "Your inbox, emptied of paperwork.",
  },
  {
    slug: "convert-mkv-to-mp4",
    cluster: "“This file won't play” — convert MKV/AVI to MP4 your TV or phone accepts",
    eyebrow: "Fix it with Stella · Video files",
    metaTitle: "MKV won't play on your TV? Converted to what it accepts",
    metaDescription:
      "'This file cannot be played'? Stella reads what's in the file, converts exactly the codec your TV or phone rejects, and hands back an MP4 that just plays — one file or a whole folder.",
    headline: "“This file can't be played”?",
    headlineAccent: "It will be.",
    lede: "Sound but no picture, picture but no sound, or a flat “format not supported.” Stella looks at what's actually inside the file, converts exactly the codec your TV or phone rejects — HEVC to H.264, EAC3 audio to AAC — and hands back an MP4 that just plays. One file or the whole folder.",
    symptoms: [
      "mkv won't play on my tv fix",
      "convert mkv to mp4 for samsung tv",
      "video plays but no sound on tv convert",
      "this file cannot be played format not supported",
      "unsupported audio codec convert video",
      "convert wmv to mp4 windows",
    ],
    prompt:
      "My TV won't play these MKVs — I get sound but no picture. Convert the folder to something it accepts.",
    steps: [
      "Inspects the file to see exactly which video or audio stream the device rejects",
      "Remuxes when only the container is wrong — fast and lossless",
      "Transcodes only the offending codec when it has to, keeping quality",
      "Handles the whole folder in a batch and verifies the output plays",
    ],
    scope:
      "DRM-protected files can't be converted — Stella tells you when that's what you've got. Everything else is deterministic conversion work on your machine, and your files never get uploaded to a sketchy converter site.",
    ctaHeadline: "Files that just play.",
  },
  {
    slug: "docker-wont-start",
    cluster: "Docker & docker-compose won't start — permission-denied volumes, port already allocated, restart loops",
    eyebrow: "Fix it with Stella · Dev tools",
    metaTitle: "Docker compose won't start? Logs read, stack up green",
    metaDescription:
      "Permission-denied volumes, port already allocated, restart loops — Stella reads your compose file and container logs, fixes the ownership, port, or YAML, and brings the stack up.",
    headline: "Containers won't come up?",
    headlineAccent: "Logs read. Stack green.",
    lede: "Permission-denied volumes, “port is already allocated,” a container stuck in a restart loop. Stella reads your compose file and the actual container logs on your machine, fixes the volume ownership, frees or remaps the port, corrects the YAML, and brings the stack up green.",
    symptoms: [
      "docker compose permission denied volume fix",
      "docker error bind for 0.0.0.0 port is already allocated",
      "docker container keeps restarting exited code 1",
      "docker got permission denied while trying to connect to the docker daemon socket",
      "cannot start service ports are not available windows",
      "how to fix docker volume permissions linux",
    ],
    prompt:
      "docker compose up fails with 'permission denied' on a volume and one container keeps restarting. Fix the stack.",
    steps: [
      "Reads the compose file and the failing containers' logs — the actual errors",
      "Fixes bind-mount ownership with the right chown or user: mapping",
      "Finds what's squatting on the conflicting port and frees or remaps it",
      "Corrects the YAML, re-ups the stack, and watches until everything is healthy",
    ],
    scope:
      "Everything is local and reproducible — Stella explains the root cause of each failure, so the stack stays fixed instead of breaking the same way next week.",
    ctaHeadline: "docker compose up. Green.",
  },
  {
    slug: "creative-cloud-wont-open",
    cluster: "Adobe Creative Cloud desktop app won't open / install / activate",
    eyebrow: "Fix it with Stella · Creative apps",
    metaTitle: "Creative Cloud stuck on a white screen? Fixed in minutes",
    metaDescription:
      "Creative Cloud won't open, white screen, sign-in loop, Photoshop in trial mode? Stella does Adobe's own documented fix for you — cache clear, Cleaner Tool, clean reinstall.",
    headline: "Creative Cloud stuck on white?",
    headlineAccent: "No reinstall marathon.",
    lede: "White screen, endless loading, sign-in loops, Photoshop claiming trial mode when you pay every month. Stella does the Adobe support-forum fix for you: quits the stuck processes, clears the exact OOBE and SLCache files Adobe's own docs point at, runs the Cleaner Tool if needed, and reinstalls cleanly — while you watch.",
    symptoms: [
      "creative cloud won't open",
      "creative cloud desktop white screen",
      "creative cloud stuck on loading screen",
      "photoshop opening in trial mode after paying",
      "creative cloud sign in loop keeps signing me out",
      "adobe app won't update stuck downloading",
    ],
    prompt:
      "Creative Cloud is a blank white window and Photoshop says trial mode even though I pay for it. Fix it.",
    steps: [
      "Quits every stuck Adobe background process cleanly",
      "Clears the corrupt OOBE/opm.db and SLCache/SLStore files — Adobe's own documented remedy",
      "Fixes the folder permissions that break activation",
      "Runs the Creative Cloud Cleaner Tool and reinstalls cleanly only if the light fixes don't take, then confirms your apps open and stay signed in",
    ],
    scope:
      "Enterprise or school-managed Adobe licenses can require your organization's admin console, which Stella can't reach — it will tell you if you're in that case. On a personal plan, the whole fix happens on your machine.",
    ctaHeadline: "Photoshop open by the time coffee's done.",
  },
];

export function getFixPage(slug: string): FixPage | undefined {
  return FIX_PAGES.find((page) => page.slug === slug);
}
