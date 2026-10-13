#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Places Midpoint
# @raycast.mode fullOutput
# @raycast.packageName Places
# @raycast.icon 📍
# @raycast.argument1 { "type": "text", "placeholder": "region" }
# @raycast.argument2 { "type": "text", "placeholder": "list URL(s), optional if saved", "optional": true }
# @raycast.description Scrape a region's Google Maps list(s), compute the midpoint and open it. URLs are remembered per region in regions.json.

cd /Users/mohamed/personal/places-midpoint || exit 1
BUN="$HOME/.bun/bin/bun"
region=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')

# Save new URL(s) for the region if given, then print its URLs one per line
if ! urls=$("$BUN" -e '
  const [region, input] = process.argv.slice(1);
  const regions = await Bun.file("regions.json").json();
  const given = input.split(/[\s,]+/).filter(Boolean);
  if (given.length) {
    regions[region] = given.length === 1 ? given[0] : given;
    await Bun.write("regions.json", JSON.stringify(regions, null, 2) + "\n");
  }
  if (!regions[region]) {
    console.error(`No saved URL for "${region}", pass a list URL. Saved: ${Object.keys(regions).join(", ")}`);
    process.exit(1);
  }
  console.log([regions[region]].flat().join("\n"));
' "$region" "$2" 2>&1); then
  echo "❌ $urls"
  exit 1
fi

# Stream the output and grab the midpoint link from it
exec 3>&1
link=$(set -f; "$BUN" processPlaces.ts --region "$region" --output "$region.json" --urls $urls 2>&1 |
  tee /dev/fd/3 | grep -o 'https://www\.google\.com/maps?q=[-0-9.,]*' | tail -1)

if [ -z "$link" ]; then
  echo "❌ No midpoint link in the output above"
  exit 1
fi
open "$link"
echo "📍 Opened $link"

# Open places that are permanently closed or gone from Google, so they can be removed from the lists
# (a gone place's link is its list, since its own page is blank)
"$BUN" -e '
  const opened = new Set();
  for (const [name, p] of Object.entries(await Bun.file(process.argv[1]).json()))
    if (p.current && (p.permanentlyClosed || p.gone)) {
      const lists = p.categories.join(", ");
      console.log(p.gone ? `🫥 No longer on Google: ${name} (${lists}), remove it in the list` : `🚫 Permanently closed: ${name} (${lists})`);
      const link = p.url ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${p.address ?? ""}`)}`;
      if (!opened.has(link)) {
        opened.add(link);
        Bun.spawn(["open", link]);
      }
    }
' "$region.json"

# List the worst-rated places that are still open
"$BUN" -e '
  const rated = Object.entries(await Bun.file(process.argv[1]).json())
    .filter(([, p]) => p.current && p.rating && !p.permanentlyClosed && !p.gone)
    .sort(([, a], [, b]) => a.rating - b.rating);
  console.log("\n👎 Worst rated:");
  for (const [name, p] of rated.slice(0, 10))
    console.log(`   ${p.rating.toFixed(1)}★ (${p.reviews.toLocaleString("en")}) ${name} (${p.categories.join(", ")})`);
' "$region.json"
