import { promises as fs } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";

const DATA_DIR = "./data";
const BASE_CHART_URL = "https://quickchart.io/chart";
const DATA_BASE_URL = "https://anandchowdhary.github.io/food/data";
const RECENT_DAY_COUNT = 3;
const RECENT_MEAL_COUNT = 3;
const RECENT_RESTAURANT_COUNT = 3;

const numberFields = new Set([
  "entries",
  "meals",
  "items",
  "grams",
  "kcal",
  "protein_g",
  "fat_g",
  "carbs_g",
  "fiber_g",
  "protein_goal_g",
  "kcal_goal",
  "protein_goal_pct",
]);

const readCSV = async (fileName) => {
  const file = await fs.readFile(join(DATA_DIR, fileName), "utf-8");
  return parse(file, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }).map((row) => {
    for (const [key, value] of Object.entries(row)) {
      if (numberFields.has(key) && value !== "") row[key] = Number(value);
    }
    return row;
  });
};

const readJSON = async (fileName) =>
  JSON.parse(await fs.readFile(join(DATA_DIR, fileName), "utf-8"));

const fmt = (value, digits = 1) => {
  if (value == null || Number.isNaN(value)) return "";
  if (Math.abs(value) >= 100 || digits === 0) return Math.round(value).toLocaleString("en-US");
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
};

const mean = (values) => {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
};

const min = (values) => {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  return nums.length ? Math.min(...nums) : null;
};

const max = (values) => {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  return nums.length ? Math.max(...nums) : null;
};

const latest = (rows) => rows[rows.length - 1];
const last = (rows, count) => rows.slice(Math.max(0, rows.length - count));
const compactList = (values) => values.filter(Boolean).join(", ");
const tableCell = (value) => String(value ?? "").replaceAll("|", "\\|");
const hasRating = (row, pattern) => pattern.test(row.ratings || "");

const displayDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00.000Z`).toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });

const latestDate = (dates) => dates.filter(Boolean).sort().at(-1);

const chartUrl = (config) =>
  `${BASE_CHART_URL}?width=1000&height=500&format=svg&chart=${encodeURIComponent(
    JSON.stringify(config),
  )}`;

const lineChart = ({ labels, datasets, stacked = false }) =>
  chartUrl({
    type: "line",
    data: { labels, datasets },
    options: {
      scales: {
        xAxes: [{ type: "time" }],
        yAxes: stacked ? [{ stacked: true }] : undefined,
      },
    },
  });

const replaceSection = (readme, name, content) => {
  const startMarker = `<!-- start ${name} -->`;
  const endMarker = `<!-- end ${name} -->`;
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) throw new Error(`Missing ${name} markers`);
  return `${readme.slice(0, start + startMarker.length)}\n\n${content.trim()}\n\n${readme.slice(end)}`;
};

const summaryRow = (label, rows, key, digits = 1) => {
  const values = rows.map((row) => row[key]);
  const latestValue = latest(rows)?.[key];
  return `| ${label} | **${fmt(latestValue, digits)}** | ${fmt(mean(last(rows, 7).map((row) => row[key])), digits)} | ${fmt(mean(last(rows, 30).map((row) => row[key])), digits)} | ${fmt(mean(values), digits)} | ${fmt(min(values), digits)} | ${fmt(max(values), digits)} |`;
};

const buildRestaurantStatsRows = (restaurants) => {
  if (!restaurants.length) return "";

  const latestRestaurant = latest(restaurants);
  const uniqueRestaurants = new Set(restaurants.map((row) => row.restaurant)).size;
  const cities = new Set(restaurants.map((row) => row.city)).size;
  const michelinStarMeals = restaurants.filter((row) => hasRating(row, /Michelin Star/i)).length;
  const michelinListedMeals = restaurants.filter((row) => hasRating(row, /Michelin/i)).length;
  const gaultMillauMeals = restaurants.filter((row) => hasRating(row, /Gault&Millau/i)).length;
  const overallScores = restaurants.map((row) => row.overall);
  const averageOverall = mean(overallScores);

  return `| Restaurant meals | ${restaurants.length.toLocaleString("en-US")} |
| Unique restaurants | ${uniqueRestaurants.toLocaleString("en-US")} |
| Cities with restaurant meals | ${cities.toLocaleString("en-US")} |
| Michelin star meals | ${michelinStarMeals.toLocaleString("en-US")} |
| Michelin guide-listed meals | ${michelinListedMeals.toLocaleString("en-US")} |
| Gault&Millau meals | ${gaultMillauMeals.toLocaleString("en-US")} |
| Restaurant meals with overall scores | ${overallScores.filter((value) => typeof value === "number").length.toLocaleString("en-US")} |
| Average overall restaurant score | ${fmt(averageOverall, 2)} |
| Latest restaurant meal | ${latestRestaurant.date} - ${latestRestaurant.restaurant} |`;
};

const buildStats = ({ entries, meals, daily, restaurants }) => {
  if (!daily.length) return "No food data yet.";
  const firstDay = daily[0];
  const latestDay = latest(daily);

  return `| Metric | Value |
| --- | --- |
| First logged day | ${firstDay.date} |
| Latest logged day | ${latestDay.date} |
| Logged days | ${daily.length.toLocaleString("en-US")} |
| Food entries | ${entries.length.toLocaleString("en-US")} |
| Meals | ${meals.length.toLocaleString("en-US")} |
${buildRestaurantStatsRows(restaurants)}

| Metric | Latest day | 7-day avg | 30-day avg | Mean | Min | Max |
| --- | --- | --- | --- | --- | --- | --- |
${summaryRow("Calories (kcal)", daily, "kcal", 0)}
${summaryRow("Protein (g)", daily, "protein_g")}
${summaryRow("Fat (g)", daily, "fat_g")}
${summaryRow("Carbs (g)", daily, "carbs_g")}
${summaryRow("Fiber (g)", daily, "fiber_g")}`;
};

const buildRecent = ({ meals, daily }) => {
  if (!daily.length) return "No recent meals yet.";
  const recentDays = last(daily, RECENT_DAY_COUNT).reverse();
  const recentMeals = last(meals, RECENT_MEAL_COUNT).reverse();

  return `### Last ${RECENT_DAY_COUNT} logged days

| Date | Entries | Meals | kcal | Protein | Fat | Carbs | Fiber |
| --- | --- | --- | --- | --- | --- | --- | --- |
${recentDays
  .map(
    (row) =>
      `| ${row.date} | ${row.entries} | ${row.meals} | ${fmt(row.kcal, 0)} | ${fmt(
        row.protein_g,
      )}g | ${fmt(row.fat_g)}g | ${fmt(row.carbs_g)}g | ${fmt(row.fiber_g)}g |`,
  )
  .join("\n")}

### Last ${RECENT_MEAL_COUNT} meals

| Date | Meal | Foods | kcal | Protein |
| --- | --- | --- | --- | --- |
${recentMeals
  .map(
    (row) =>
      `| ${row.date} | ${row.meal} | ${row.foods} | ${fmt(row.kcal, 0)} | ${fmt(row.protein_g)}g |`,
  )
  .join("\n")}`;
};

const buildRestaurants = ({ restaurants }) => {
  if (!restaurants.length) return "No restaurant meals yet.";
  const recentRestaurants = last(restaurants, RECENT_RESTAURANT_COUNT).reverse();

  return `### API

The restaurant meals are available as JSON at ${DATA_BASE_URL}/restaurants.json.

### Latest ${RECENT_RESTAURANT_COUNT} restaurant meals

| Date | Occasion | Restaurant | City | Recognition | Overall | Notes |
| --- | --- | --- | --- | --- | --- | --- |
${recentRestaurants
  .map((row) => {
    const occasion = tableCell(row.occasion);
    const recognition = tableCell(row.ratings);
    const notes = tableCell(row.notes);
    return `| ${row.date} | ${occasion} | ${tableCell(row.restaurant)} | ${tableCell(row.city)} | ${recognition} | ${fmt(row.overall, 2)} | ${notes} |`;
  })
  .join("\n")}`;
};

const buildGraphs = ({ daily }) => {
  if (!daily.length) return "No graphs yet.";
  const chartRows = daily.slice(-120);
  const labels = chartRows.map((row) => row.date);

  const caloriesChart = lineChart({
    labels,
    datasets: [
      {
        label: "Calories (kcal)",
        data: chartRows.map((row) => row.kcal),
        borderColor: "#4c78a8",
        backgroundColor: "#4c78a8",
        fill: false,
        lineTension: 0.35,
      },
      {
        label: "Calories goal",
        data: chartRows.map((row) => row.kcal_goal || null),
        borderColor: "rgba(75, 192, 75, 0.35)",
        backgroundColor: "transparent",
        borderDash: [5, 5],
        pointRadius: 0,
        fill: false,
      },
    ],
  });

  const proteinChart = lineChart({
    labels,
    datasets: [
      {
        label: "Protein (g)",
        data: chartRows.map((row) => row.protein_g),
        borderColor: "#f58518",
        backgroundColor: "#f58518",
        fill: false,
        lineTension: 0.35,
      },
      {
        label: "Protein goal",
        data: chartRows.map((row) => row.protein_goal_g || null),
        borderColor: "rgba(75, 192, 75, 0.35)",
        backgroundColor: "transparent",
        borderDash: [5, 5],
        pointRadius: 0,
        fill: false,
      },
    ],
  });

  const macrosChart = lineChart({
    labels,
    datasets: [
      {
        label: "Protein (g)",
        data: chartRows.map((row) => row.protein_g),
        borderColor: "#f58518",
        backgroundColor: "#f58518",
        fill: false,
      },
      {
        label: "Fat (g)",
        data: chartRows.map((row) => row.fat_g),
        borderColor: "#e45756",
        backgroundColor: "#e45756",
        fill: false,
      },
      {
        label: "Carbs (g)",
        data: chartRows.map((row) => row.carbs_g),
        borderColor: "#72b7b2",
        backgroundColor: "#72b7b2",
        fill: false,
      },
      {
        label: "Fiber (g)",
        data: chartRows.map((row) => row.fiber_g),
        borderColor: "#54a24b",
        backgroundColor: "#54a24b",
        fill: false,
      },
    ],
  });

  return `### Calories

![Chart showing calories over time](${caloriesChart})

### Protein

![Chart showing protein over time](${proteinChart})

### Macros

![Chart showing macro grams over time](${macrosChart})`;
};

const main = async () => {
  const readme = await fs.readFile("./README.md", "utf-8");
  const entries = await readCSV("entries.csv");
  const meals = await readCSV("meals.csv");
  const daily = await readCSV("daily.csv");
  const restaurants = await readJSON("restaurants.json");

  daily.sort((a, b) => a.date.localeCompare(b.date));
  meals.sort((a, b) => `${a.date} ${a.first_time}`.localeCompare(`${b.date} ${b.first_time}`));
  entries.sort((a, b) => a.datetime.localeCompare(b.datetime));
  restaurants.sort((a, b) =>
    compactList([a.date, a.restaurant]).localeCompare(compactList([b.date, b.restaurant])),
  );

  const lastUpdated = displayDate(latestDate([latest(daily)?.date, latest(restaurants)?.date]));

  let nextReadme = readme;
  nextReadme = replaceSection(
    nextReadme,
    "stats",
    `${buildStats({ entries, meals, daily, restaurants })}\n\n_Last updated: ${lastUpdated}_`,
  );
  nextReadme = replaceSection(nextReadme, "recent", buildRecent({ meals, daily }));
  nextReadme = replaceSection(nextReadme, "restaurants", buildRestaurants({ restaurants }));
  nextReadme = replaceSection(nextReadme, "graphs", buildGraphs({ daily }));

  await fs.writeFile("./README.md", nextReadme);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
