// Formats knip --reporter json output into a compact summary.
// Input: JSON on stdin. Output: plain text summary on stdout.
// Schema: { issues: [{ file, exports?, types?, dependencies?, files?, ... }] }

const MAX_ITEMS = { exports: 15, types: 10, files: 10, deps: 10 };

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let raw;
  try {
    raw = Buffer.concat(chunks).toString();
  } catch (err) {
    console.log(`knip analysis failed — read error: ${err.message}`);
    process.exit(0);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.log("knip analysis failed — JSON parse error");
    } else {
      console.log(`knip analysis failed — ${err.message}`);
    }
    process.exit(0);
  }

  if (!report || !Array.isArray(report.issues)) {
    console.log("knip analysis failed — unexpected JSON structure");
    process.exit(0);
  }

  const lines = [
    "Dead-code candidates (verify before deleting — dynamic usage may be missed)",
  ];

  const allExports = [];
  const allTypes = [];
  const allDeps = [];
  const allDevDeps = [];
  const allFiles = [];
  const allUnlisted = [];
  const allUnresolved = [];

  for (const entry of report.issues) {
    const file = entry.file || "?";
    const collect = (arr, items) => {
      if (!items?.length) return;
      for (const item of items) {
        arr.push(item.name ? `${file}:${item.name}` : file);
      }
    };
    collect(allExports, entry.exports);
    collect(allExports, entry.nsExports);
    collect(allTypes, entry.types);
    collect(allTypes, entry.nsTypes);
    collect(allTypes, entry.enumMembers);
    if (entry.dependencies?.length) {
      allDeps.push(...entry.dependencies.map((d) => d.name));
    }
    if (entry.devDependencies?.length) {
      allDevDeps.push(...entry.devDependencies.map((d) => d.name));
    }
    if (entry.files?.length) {
      allFiles.push(...entry.files.map((f) => f.name || file));
    }
    if (entry.unlisted?.length) {
      allUnlisted.push(...entry.unlisted.map((d) => d.name));
    }
    if (entry.unresolved?.length) {
      allUnresolved.push(...entry.unresolved.map((d) => `${file}:${d.name}`));
    }
  }

  if (allExports.length > 0) {
    lines.push(`Unused exports (${allExports.length}): ${allExports.slice(0, MAX_ITEMS.exports).join(", ")}`);
  }
  if (allTypes.length > 0) {
    lines.push(`Unused types (${allTypes.length}): ${allTypes.slice(0, MAX_ITEMS.types).join(", ")}`);
  }
  if (allFiles.length > 0) {
    lines.push(`Unused files (${allFiles.length}): ${allFiles.slice(0, MAX_ITEMS.files).join(", ")}`);
  }
  if (allDeps.length > 0) {
    lines.push(`Unused dependencies (${allDeps.length}): ${allDeps.slice(0, MAX_ITEMS.deps).join(", ")}`);
  }
  if (allDevDeps.length > 0) {
    lines.push(`Unused devDependencies (${allDevDeps.length}): ${allDevDeps.slice(0, MAX_ITEMS.deps).join(", ")}`);
  }
  if (allUnlisted.length > 0) {
    lines.push(`Unlisted deps (${allUnlisted.length}): ${allUnlisted.slice(0, MAX_ITEMS.deps).join(", ")}`);
  }
  if (allUnresolved.length > 0) {
    lines.push(`Unresolved imports (${allUnresolved.length}): ${allUnresolved.slice(0, MAX_ITEMS.exports).join(", ")}`);
  }

  if (lines.length === 1) {
    lines.push("No unused exports, files, or dependencies found");
  }

  console.log(lines.join("\n"));
  process.exit(0);
});
