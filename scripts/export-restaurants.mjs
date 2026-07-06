import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

const DEFAULT_SHEET_ID = "1l-rDc8DLPoxfuCYkAvM2eS4IcSg6NYUr4hzsXJhD0QU";
const DEFAULT_SHEET_GID = "0";
const DEFAULT_OUTPUT = "data/restaurants.json";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

const fields = [
  { source: "Date", key: "date" },
  { source: "Occasion", key: "occasion" },
  { source: "Restaurant", key: "restaurant" },
  { source: "City", key: "city" },
  { source: "Ratings", key: "ratings" },
  { source: "Food", key: "food" },
  { source: "Service", key: "service" },
  { source: "Vibe", key: "vibe" },
  { source: "Overall", key: "overall" },
  { source: "Notes", key: "notes" },
];

const numberFields = new Set(["food", "service", "vibe", "overall"]);
const monthNumbers = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, String(index + 1).padStart(2, "0")],
  ),
);

const sheetId = process.env.RESTAURANTS_SHEET_ID || DEFAULT_SHEET_ID;
const sheetGid = process.env.RESTAURANTS_SHEET_GID || DEFAULT_SHEET_GID;
const output = process.env.RESTAURANTS_OUTPUT || DEFAULT_OUTPUT;
const outputPath = isAbsolute(output) ? output : join(repoRoot, output);

const sheetUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
sheetUrl.searchParams.set("format", "csv");
sheetUrl.searchParams.set("gid", sheetGid);

const formatDate = (year, month, day) => {
  const isoDate = `${year}-${month}-${day}`;
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error(`Invalid date: ${isoDate}`);
  }
  return isoDate;
};

const normalizeDate = (value) => {
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return formatDate(isoMatch[1], isoMatch[2], isoMatch[3]);

  const textMatch = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!textMatch) throw new Error(`Unexpected date format: ${value}`);

  const [, monthName, day, year] = textMatch;
  const month = monthNumbers.get(monthName.toLowerCase());
  if (!month) throw new Error(`Unexpected month in date: ${value}`);
  return formatDate(year, month, day.padStart(2, "0"));
};

const normalizeNumber = (key, value) => {
  const number = Number(value.replace(",", "."));
  if (!Number.isFinite(number)) throw new Error(`Expected ${key} to be numeric, got: ${value}`);
  return number;
};

const normalizeValue = (key, rawValue) => {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;
  if (key === "date") return normalizeDate(value);
  if (numberFields.has(key)) return normalizeNumber(key, value);
  return value;
};

const fetchCsv = async () => {
  const response = await fetch(sheetUrl, {
    headers: { "User-Agent": "@anandchowdhary/food restaurants exporter" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet CSV: ${response.status} ${response.statusText}`);
  }
  return response.text();
};

const main = async () => {
  const csv = await fetchCsv();
  let headers = [];
  const rows = parse(csv, {
    bom: true,
    columns: (csvHeaders) => {
      headers = csvHeaders;
      return csvHeaders;
    },
    skip_empty_lines: true,
    trim: true,
  }).filter((row) => fields.some(({ source }) => String(row[source] ?? "").trim()));

  const missingHeaders = fields
    .map(({ source }) => source)
    .filter((source) => !headers.includes(source));
  if (missingHeaders.length) {
    throw new Error(`Missing required sheet columns: ${missingHeaders.join(", ")}`);
  }

  const restaurants = rows.map((row) =>
    Object.fromEntries(fields.map(({ source, key }) => [key, normalizeValue(key, row[source])])),
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(restaurants, null, 2)}\n`);

  console.log(`Wrote ${restaurants.length} restaurants to ${relative(repoRoot, outputPath)}`);
};

await main();
