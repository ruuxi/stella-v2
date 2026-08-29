import type { StellaMiniChatExchange } from "@/components/stella-mini-chat";
import { FIX_PAGES } from "@/lib/fix-pages";

// Per-/fix page conversation for the shared Stella mini-chat.
// Keep it short: the visitor's own words, then a truthful done-state.
export const FIX_PAGE_DEMOS: Record<string, StellaMiniChatExchange[]> = {
  "comfyui-broken-after-update": [
    {
      user: "ComfyUI won't start since I updated it — the console says 'Failed to import custom node' and something about torch and CUDA versions.",
      reply:
        "The log is a torch/CUDA mismatch plus one custom node that won't import. I'll install a matching set and pin that node.",
    },
    {
      user: "Don't touch my workflows.",
      reply:
        "Workflows and models stay put. ComfyUI is launching clean now — I quarantined the abandoned node instead of faking a fix.",
    },
  ],
  "stop-fake-virus-popups": [
    {
      user: "I keep getting 'McAfee virus alert' pop-ups in the bottom-right corner and I don't even have McAfee. Make them stop.",
      reply:
        "Those aren't a virus — they're browser notifications a site tricked you into allowing. I'll revoke every rogue permission.",
    },
    {
      user: "And stop new ones?",
      reply:
        "Done. Default is now “don't allow,” and the sites that were nagging can't ask again.",
    },
  ],
  "c-drive-full": [
    {
      user: "My C drive is full and Windows can't install its update. Figure out what's eating the space and what I can actually delete.",
      reply:
        "Biggest hogs: old installers, temp files, and a duplicate Downloads pile. Here's what's safe vs. your actual stuff.",
    },
    {
      user: "Clean the safe ones.",
      reply:
        "Cleared what you approved. There's enough room for the update now — nothing else was deleted.",
    },
  ],
  "merge-excel-files": [
    {
      user: "Merge every CSV in this folder into one spreadsheet — same columns, no duplicate rows, dates formatted consistently.",
      reply:
        "Twelve files, mismatched headers. I'll align the columns, dedupe rows, and write one clean workbook.",
    },
    {
      user: "Dates as dates, please.",
      reply:
        "Done — dates are real dates, numbers are numbers. The file is on your desktop.",
    },
  ],
  "bank-statement-to-excel": [
    {
      user: "Turn these twelve statements into one spreadsheet of transactions — date, description, amount, category — newest first.",
      reply:
        "Reading the PDFs locally. I'll extract every transaction and categorize them the way you asked.",
    },
    {
      user: "Keep them on this computer.",
      reply:
        "They never left. One spreadsheet is saved here — I flagged two blurry rows for a quick look.",
    },
  ],
  "website-data-to-excel": [
    {
      user: "Go through all 40 pages of this directory and build me a spreadsheet with name, city, phone, and website for every listing.",
      reply:
        "Opening it in your browser. I'll walk every page and pull just those four columns.",
    },
    {
      user: "No text-that-looks-like-numbers.",
      reply:
        "Deduped, phones as numbers, 612 rows. The sheet is on your desktop.",
    },
  ],
  "sims-4-mods-broken": [
    {
      user: "Sims 4 won't load after today's patch. Figure out which of my mods broke and fix what can be fixed.",
      reply:
        "lastException points to two outdated script mods. I'll pull the updates and set the rest aside.",
    },
    {
      user: "Don't wipe the Mods folder.",
      reply:
        "Didn't. Updated what I could, quarantined one with no patch yet. The game is loading.",
    },
  ],
  "minecraft-modpack-crash": [
    {
      user: "My CurseForge modpack crashes with 'exit code 1' the second I hit play. Read the crash report and fix it.",
      reply:
        "Wrong Java and one conflicting overlay mod. I'll install the Java the pack wants and pull the conflict.",
    },
    {
      user: "Then launch it.",
      reply: "Java 17 is pointed at the launcher, RAM is set, pack is up. You're in.",
    },
  ],
  "obs-black-screen": [
    {
      user: "OBS is just a black screen since it updated — display capture shows nothing. Fix it without losing my scenes.",
      reply:
        "The update flipped the capture method. I'll switch it back and re-grant screen recording.",
    },
    {
      user: "Scenes stay?",
      reply: "Scenes and sources untouched. Test capture is live — no more black frame.",
    },
  ],
  "missing-vst-plugins": [
    {
      user: "Ableton stopped seeing half my VSTs after the update. Find them and get them back in the browser.",
      reply:
        "They're still on disk — the search path dropped a folder, and one plugin is crashing the scan.",
    },
    {
      user: "Fix the path, quarantine the crasher.",
      reply:
        "Paths restored, crasher set aside, plugin database rebuilt. The rest are back in the browser.",
    },
  ],
  "game-mods-broken-after-patch": [
    {
      user: "Cyberpunk mods stopped working after the update — update whatever needs updating and get my load order working again.",
      reply:
        "RED4ext and two framework mods are behind. I'll update those first, then rebuild the load order.",
    },
    {
      user: "Leave anything that has no update.",
      reply: "Quarantined one outdated script so the rest can run. Game starts clean.",
    },
  ],
  "onedrive-moved-my-files": [
    {
      user: "My desktop files disappeared and everything says it's in OneDrive now. Put it back the way it was without losing anything.",
      reply:
        "Windows redirected Desktop into OneDrive. I'll download anything that's cloud-only before I touch settings.",
    },
    {
      user: "Then undo the hijack.",
      reply:
        "Local copies are here, backup switch is off, Desktop points home again. Nothing missing.",
    },
  ],
  "organize-downloads-folder": [
    {
      user: "Clean up my Downloads folder — group things by what they are, keep the last month easy to reach, archive the rest.",
      reply:
        "4,128 files. I'll show a dry-run first — type folders, last 30 days up front, older stuff archived.",
    },
    {
      user: "Looks right. Do it, don't delete yet.",
      reply:
        "Moved everything as planned. Duplicates are flagged, nothing deleted. The pass is undoable.",
    },
  ],
  "plex-not-matching": [
    {
      user: "Plex thinks half my movies are different movies and some shows won't appear at all. Fix the names and folders so everything matches.",
      reply:
        "It's the filenames. I'll rename to Plex's convention and fix the Season/Episode folders.",
    },
    {
      user: "Then rescan.",
      reply:
        "Library rescanned. Posters match; two obscure titles are flagged for a manual pick.",
    },
  ],
  "car-usb-music": [
    {
      user: "My car says 'no supported files' on my music USB. Make me a stick it will actually play, with albums in order.",
      reply:
        "Head unit wants FAT32 and MP3. I'll reformat, convert the FLACs, and number the folders.",
    },
    {
      user: "Albums in order.",
      reply:
        "Stick is ready — tags cleaned, leading-zero names, under the per-folder limit.",
    },
  ],
  "externally-managed-environment": [
    {
      user: "pip says 'this environment is externally managed' and my script won't run. Set it up properly and run it.",
      reply:
        "That's your system Python protecting itself. I'll make a venv, install what the script needs, and run it there.",
    },
    {
      user: "No --break-system-packages.",
      reply: "Didn't. venv is active, deps installed, script finished clean.",
    },
  ],
  "vcruntime140-dll-missing": [
    {
      user: "My game won't launch — 'The code execution cannot proceed because VCRUNTIME140.dll was not found.' Fix it.",
      reply:
        "That's a missing Visual C++ runtime, not a random DLL. I'll install the real one from Microsoft.",
    },
    {
      user: "Both 32 and 64?",
      reply: "Both installed. Game launched. No sketchy DLL sites involved.",
    },
  ],
  "path-too-long": [
    {
      user: "There's a folder Windows refuses to delete — 'source path too long.' Get rid of it.",
      reply:
        "Classic long-path lock. I'll enable long paths and empty the tree the way IT does it.",
    },
    {
      user: "Just that folder.",
      reply:
        "Gone. Nothing else touched — the folder Windows wouldn't delete is deleted.",
    },
  ],
  "git-disaster-recovery": [
    {
      user: "I ran git reset --hard and lost a day of work. Get it back.",
      reply:
        "Reflog still has the commits. I'll restore them onto a recovery branch before anything else moves.",
    },
    {
      user: "Don't force-push.",
      reply:
        "Didn't. Day's work is on `recover/today`. History is intact — your call if you merge it.",
    },
  ],
  "fix-music-tags": [
    {
      user: "Fix the tags and album art for my whole music folder and organize it into Artist/Album folders.",
      reply:
        "I'll fingerprint the audio, pull titles and covers from MusicBrainz, then file everything cleanly.",
    },
    {
      user: "Skip anything you aren't sure about.",
      reply:
        "Library is tagged and filed. Twelve live/bootleg tracks are queued for you instead of guessed.",
    },
  ],
  "windows-start-menu-broken": [
    {
      user: "Windows 11 search won't accept typing and the Start button does nothing since the update. Fix it without a reset.",
      reply:
        "Start and Search packages are wedged. I'll restart the services and re-register them — no factory reset.",
    },
    {
      user: "Did it work?",
      reply: "Start opens, search accepts typing. No data loss.",
    },
  ],
  "download-email-attachments": [
    {
      user: "Download every invoice PDF anyone has ever emailed me and sort them into folders by year.",
      reply:
        "I'll search your logged-in inbox, save each PDF, and file them by year on this computer.",
    },
    {
      user: "Don't upload them anywhere.",
      reply: "They never left your machine. 148 invoices, deduped, filed by year.",
    },
  ],
  "convert-mkv-to-mp4": [
    {
      user: "My TV won't play these MKVs — I get sound but no picture. Convert the folder to something it accepts.",
      reply:
        "Video is HEVC; the TV wants H.264. I'll transcode just that stream and leave the rest.",
    },
    {
      user: "Whole folder.",
      reply: "Batch is done. Outputs play — no upload, no DRM files in the set.",
    },
  ],
  "docker-wont-start": [
    {
      user: "docker compose up fails with 'permission denied' on a volume and one container keeps restarting. Fix the stack.",
      reply:
        "Volume ownership is wrong and a port is already taken. I'll chown the bind mount and remap the port.",
    },
    {
      user: "Bring it up.",
      reply: "YAML corrected, stack is healthy. Restart loop is gone.",
    },
  ],
  "creative-cloud-wont-open": [
    {
      user: "Creative Cloud is a blank white window and Photoshop says trial mode even though I pay for it. Fix it.",
      reply:
        "Corrupt OOBE/SLCache — Adobe's own documented case. I'll clear those files and restart the app.",
    },
    {
      user: "Don't do a full reinstall unless you have to.",
      reply:
        "Didn't need to. Creative Cloud opens, Photoshop is signed in on your plan.",
    },
  ],
  "photoshop-scratch-disk-full": [
    {
      user: "Photoshop won't open because it says the scratch disks are full. Fix it without deleting any of my project files.",
      reply:
        "Your PSDs are safe. The scratch disk has 38 GB of abandoned Photoshop temp files; I'll show you those before clearing anything.",
    },
    {
      user: "Clear only the temp files and test it.",
      reply:
        "Approved temp files cleared. Photoshop reopened and a document loads without the scratch-disk warning.",
    },
  ],
  "microphone-not-working-windows": [
    {
      user: "My microphone works in Windows settings but nobody can hear me in Discord. Find the problem and test it.",
      reply:
        "Windows has signal, but Discord is using the laptop mic and its app permission is off. I'll correct both.",
    },
    {
      user: "Make sure people can actually hear it.",
      reply:
        "Discord now has the headset input. Test recording played back clearly at a healthy level.",
    },
  ],
  "steam-game-wont-launch": [
    {
      user: "Steam says my game is launching for a few seconds, then the Play button comes back. Read whatever failed and get it running.",
      reply:
        "The crash event points to a missing Visual C++ runtime, not the game files. I'll repair the official runtime and relaunch.",
    },
    {
      user: "Don't reinstall the whole game.",
      reply:
        "No reinstall. The runtime is repaired, the game reached its main menu, and the process is staying up.",
    },
  ],
  "setup-dlss-5-one-click": [
    {
      user: "Set up this DLSS 5 build in my game, back up the current files, launch it, and roll back if it breaks.",
      reply:
        "I'll scan the package, check your game and GPU, and save the current DLSS files before replacing anything.",
    },
    {
      user: "I got it from a leak. I still want to try it.",
      reply:
        "That's okay. I'll treat it as untrusted, verify what I can, install it reversibly, and test the game without bypassing any account or access control.",
    },
  ],
};

const missingDemos = FIX_PAGES.filter((page) => !FIX_PAGE_DEMOS[page.slug]).map(
  (page) => page.slug,
);
if (missingDemos.length > 0) {
  throw new Error(`Missing /fix mini-chat demos for: ${missingDemos.join(", ")}`);
}

export function getFixPageDemo(slug: string): StellaMiniChatExchange[] {
  return FIX_PAGE_DEMOS[slug] ?? [];
}
