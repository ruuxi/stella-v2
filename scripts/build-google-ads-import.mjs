import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const marketingDir = resolve(root, "docs/marketing");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const [headers, ...values] = rows;
  return values.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const campaigns = [
  {
    name: "US | Search | Competitor | OpenCode",
    adGroup: "OpenCode",
    dailyBudget: "41.12",
    path1: "personal-ai",
  },
  {
    name: "US | Search | Coding Agent",
    adGroup: "Coding Agent",
    dailyBudget: "65.79",
    path1: "coding-agent",
  },
  {
    name: "US | Search | Personal Work",
    adGroup: "Personal Work",
    dailyBudget: "57.56",
    path1: "ai-assistant",
  },
];

const keywords = parseCsv(
  readFileSync(resolve(marketingDir, "keywords.csv"), "utf8"),
);
const negatives = parseCsv(
  readFileSync(resolve(marketingDir, "negative-keywords.csv"), "utf8"),
);
const responsiveAssets = parseCsv(
  readFileSync(resolve(marketingDir, "responsive-search-ads.csv"), "utf8"),
);

const headers = [
  "Campaign",
  "Campaign type",
  "Campaign daily budget",
  "Networks",
  "Languages",
  "Bid strategy type",
  "Maximum CPC bid limit",
  "Campaign status",
  "Mobile Bid Modifier",
  "Tablet Bid Modifier",
  "Location ID",
  "Ad Group",
  "Ad Group Status",
  "Max CPC",
  "Keyword",
  "Type",
  "Status",
  "Ad type",
  ...Array.from({ length: 15 }, (_, index) => `Headline ${index + 1}`),
  ...Array.from({ length: 4 }, (_, index) => `Description ${index + 1}`),
  "Path 1",
  "Path 2",
  "Final URL",
  "Link Text",
  "Callout text",
  "Header",
  "Snippet Values",
  "Platform Targeting",
  "Comment",
];

const bulkHeaders = [
  "Row Type",
  "Action",
  "Campaign status",
  "Campaign",
  "Campaign type",
  "Networks",
  "Budget",
  "Budget type",
  "Bid strategy type",
  "Language",
  "Location",
  "Devices",
  "EU political ads",
  "Ad group status",
  "Ad group",
  "Ad group type",
  "Default max. CPC",
  "Keyword status",
  "Keyword",
  "Negative keyword",
  "Level",
  "Type",
  "Ad status",
  "Ad type",
  ...Array.from({ length: 15 }, (_, index) => `Headline ${index + 1}`),
  ...Array.from({ length: 4 }, (_, index) => `Description ${index + 1}`),
  "Path 1",
  "Path 2",
  "Final URL",
];

const rows = [];
const add = (values) => rows.push(values);
const bulkRows = [];
const addBulk = (values) => bulkRows.push(values);
const assertLength = (label, value, limit) => {
  if (value.length > limit) {
    throw new Error(`${label} exceeds ${limit} characters: ${value}`);
  }
};

const approvedDailyBudget = campaigns.reduce(
  (sum, campaign) => sum + Number(campaign.dailyBudget),
  0,
);
if (approvedDailyBudget !== 164.47) {
  throw new Error(`Daily budgets total ${approvedDailyBudget}, expected 164.47.`);
}

for (const campaign of campaigns) {
  add({
    Campaign: campaign.name,
    "Campaign type": "Search",
    "Campaign daily budget": campaign.dailyBudget,
    Networks: "Google Search",
    Languages: "en",
    "Bid strategy type": "Maximize clicks",
    "Maximum CPC bid limit": "2.50",
    "Campaign status": "Paused",
    "Mobile Bid Modifier": "-100%",
    "Tablet Bid Modifier": "-100%",
    Comment: "Stella launch campaign; review location presence setting before enabling",
  });
  add({ Campaign: campaign.name, "Location ID": "2840" });
  add({
    Campaign: campaign.name,
    "Ad Group": campaign.adGroup,
    "Ad Group Status": "Paused",
    "Max CPC": "2.50",
  });
  addBulk({
    "Row Type": "Campaign",
    Action: "Add",
    "Campaign status": "Paused",
    Campaign: campaign.name,
    "Campaign type": "Search",
    Networks: "Google search",
    Budget: campaign.dailyBudget,
    "Budget type": "Daily",
    "Bid strategy type": "Maximize clicks",
    Language: "en",
    Location: "United States",
    Devices:
      "Computers; Mobile devices with full browsers:-100%; Tablets with full browsers:-100%",
    "EU political ads": "No",
  });
  addBulk({
    "Row Type": "Ad group",
    Action: "Add",
    "Ad group status": "Paused",
    Campaign: campaign.name,
    "Ad group": campaign.adGroup,
    "Ad group type": "Standard",
    "Default max. CPC": "2.50",
  });
}

for (const keyword of keywords) {
  add({
    Campaign: keyword.campaign,
    "Ad Group": keyword.ad_group,
    Keyword: keyword.keyword,
    Type: keyword.match_type,
    Status: "Paused",
  });
  addBulk({
    "Row Type": "Keyword",
    Action: "Add",
    "Keyword status": "Paused",
    Campaign: keyword.campaign,
    "Ad group": keyword.ad_group,
    Keyword: keyword.keyword,
    Type:
      keyword.match_type === "exact"
        ? "Exact match"
        : keyword.match_type === "phrase"
          ? "Phrase match"
          : "Broad match",
  });
}

for (const campaign of campaigns) {
  for (const negative of negatives) {
    add({
      Campaign: campaign.name,
      Keyword:
        negative.match_type === "phrase"
          ? `"${negative.keyword}"`
          : negative.keyword,
      Type: "Campaign negative",
      Comment: negative.reason,
    });
    addBulk({
      "Row Type": "Negative keyword",
      Action: "Add",
      "Keyword status": "Paused",
      Level: "Campaign",
      Campaign: campaign.name,
      "Negative keyword": negative.keyword,
      Type:
        negative.match_type === "exact"
          ? "Exact match"
          : negative.match_type === "phrase"
            ? "Phrase match"
            : "Broad match",
    });
  }
}

const ads = new Map();
for (const asset of responsiveAssets) {
  const key = [asset.campaign, asset.ad_group, asset.final_url].join("\u0000");
  const ad = ads.get(key) ?? {
    campaign: asset.campaign,
    adGroup: asset.ad_group,
    finalUrl: asset.final_url,
    headlines: [],
    descriptions: [],
  };
  ad[asset.asset_type === "headline" ? "headlines" : "descriptions"].push(
    asset.text,
  );
  ads.set(key, ad);
}

for (const ad of ads.values()) {
  const campaign = campaigns.find((candidate) => candidate.name === ad.campaign);
  for (const headline of ad.headlines) assertLength("Headline", headline, 30);
  for (const description of ad.descriptions) {
    assertLength("Description", description, 90);
  }
  assertLength("Path 1", campaign.path1, 15);
  assertLength("Path 2", "mac-windows", 15);
  add({
    Campaign: ad.campaign,
    "Ad Group": ad.adGroup,
    Status: "Paused",
    "Ad type": "Responsive search ad",
    ...Object.fromEntries(
      ad.headlines.map((headline, index) => [`Headline ${index + 1}`, headline]),
    ),
    ...Object.fromEntries(
      ad.descriptions.map((description, index) => [
        `Description ${index + 1}`,
        description,
      ]),
    ),
    "Path 1": campaign.path1,
    "Path 2": "mac-windows",
    "Final URL": ad.finalUrl,
  });
  addBulk({
    "Row Type": "Ad",
    Action: "Add",
    "Ad status": "Paused",
    Campaign: ad.campaign,
    "Ad group": ad.adGroup,
    "Ad type": "Responsive search ad",
    ...Object.fromEntries(
      ad.headlines.map((headline, index) => [`Headline ${index + 1}`, headline]),
    ),
    ...Object.fromEntries(
      ad.descriptions.map((description, index) => [
        `Description ${index + 1}`,
        description,
      ]),
    ),
    "Path 1": campaign.path1,
    "Path 2": "mac-windows",
    "Final URL": ad.finalUrl,
  });
}

const sitelinks = [
  ["Pricing", "https://stella.sh/pricing", "Start free with Stella", "Go is $5 the first month"],
  ["How Stella Works", "https://stella.sh/learn-more", "See what Stella can do", "Browser, files, apps and more"],
  ["Coding and Agents", "https://stella.sh/go#work", "Build, debug and research", "Keep background work moving"],
  ["Open Source", "https://github.com/ruuxi/stella-v2", "Read Stella's source", "Local-first desktop assistant"],
];
for (const [text, url, description1, description2] of sitelinks) {
  assertLength("Sitelink text", text, 25);
  assertLength("Sitelink description", description1, 35);
  assertLength("Sitelink description", description2, 35);
  add({
    Campaign: "<Account-level>",
    "Link Text": text,
    "Description 1": description1,
    "Description 2": description2,
    "Final URL": url,
    "Platform Targeting": "All",
  });
}

for (const callout of [
  "Start Free",
  "$5 First Month",
  "Open Source",
  "Local First",
  "Bring Your Own Models",
  "Mac and Windows",
  "Browser and Computer Use",
  "Docs and Spreadsheets",
]) {
  assertLength("Callout", callout, 25);
  add({ Campaign: "<Account-level>", "Callout text": callout });
}

add({
  Campaign: "<Account-level>",
  Header: "Features",
  "Snippet Values":
    "Coding;Computer Use;Research;Documents;Browser Automation;Voice",
});

const output = [
  headers.join(","),
  ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
].join("\n");

writeFileSync(resolve(marketingDir, "google-ads-editor-import.csv"), `${output}\n`);

const bulkOutput = [
  bulkHeaders.join(","),
  ...bulkRows.map((row) =>
    bulkHeaders.map((header) => csvCell(row[header])).join(","),
  ),
].join("\n");

writeFileSync(resolve(marketingDir, "google-ads-bulk-import.csv"), `${bulkOutput}\n`);
console.log(
  `Wrote ${rows.length} Google Ads Editor rows and ${bulkRows.length} Google Ads bulk-upload rows.`,
);
