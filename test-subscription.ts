#!/usr/bin/env -S deno run --allow-net --allow-env

// Тестовый скрипт для проверки парсинга subscription

const SUBSCRIPTION_URL = Deno.env.get("SUBSCRIPTION_URL") || "https://m.chillpad.net/L9kFkHHWBvwVK3Zu";

console.log("Fetching subscription from:", SUBSCRIPTION_URL);

const response = await fetch(SUBSCRIPTION_URL);
const base64Text = await response.text();

console.log("\n=== BASE64 Response ===");
console.log("Length:", base64Text.length);
console.log("Preview:", base64Text.substring(0, 200));

console.log("\n=== Decoding ===");
const decoded = atob(base64Text.trim());
console.log("Decoded length:", decoded.length);

console.log("\n=== Lines ===");
const lines = decoded.split("\n").filter(l => l.trim().length > 0);
console.log("Total lines:", lines.length);

console.log("\n=== First 5 lines ===");
for (let i = 0; i < Math.min(5, lines.length); i++) {
  const line = lines[i];
  console.log(`\n[${i + 1}]`);
  console.log("  Protocol:", line.split("://")[0]);
  console.log("  Preview:", line.substring(0, 100) + "...");

  // Extract label
  const hashIndex = line.indexOf("#");
  if (hashIndex !== -1) {
    const fragment = line.substring(hashIndex + 1);
    const decoded = decodeURIComponent(fragment);
    console.log("  Fragment:", decoded);

    const parts = decoded.trim().split(/\s+/);
    const label = parts[parts.length - 1];
    console.log("  Label:", label);
  }
}

console.log("\n=== Summary ===");
const protocols = new Set(lines.map(l => l.split("://")[0]));
console.log("Protocols found:", Array.from(protocols));
