const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const report = JSON.parse(Buffer.concat(chunks).toString());
    const issues = report.issues || [];
    const lines = [
      "Dead-code candidates (verify before deleting — dynamic usage may be missed)",
    ];

    const allExports = [];
    const allTypes = [];
    const allDeps = [];
    const allDevDeps = [];
    const allFiles = [];

    for (const entry of issues) {
      if (entry.exports?.length) {
        for (const e of entry.exports) {
          allExports.push(`${entry.file}:${e.name}`);
        }
      }
      if (entry.nsExports?.length) {
        for (const e of entry.nsExports) {
          allExports.push(`${entry.file}:${e.name}`);
        }
      }
      if (entry.types?.length) {
        for (const t of entry.types) {
          allTypes.push(`${entry.file}:${t.name}`);
        }
      }
      if (entry.nsTypes?.length) {
        for (const t of entry.nsTypes) {
          allTypes.push(`${entry.file}:${t.name}`);
        }
      }
      if (entry.enumMembers?.length) {
        for (const t of entry.enumMembers) {
          allTypes.push(`${entry.file}:${t.name}`);
        }
      }
      if (entry.dependencies?.length) {
        allDeps.push(...entry.dependencies.map((d) => d.name));
      }
      if (entry.devDependencies?.length) {
        allDevDeps.push(...entry.devDependencies.map((d) => d.name));
      }
      if (entry.files?.length) {
        allFiles.push(...entry.files.map((f) => f.name || entry.file));
      }
    }

    if (allExports.length > 0) {
      const items = allExports.slice(0, 15).join(", ");
      lines.push(`Unused exports (${allExports.length}): ${items}`);
    }
    if (allTypes.length > 0) {
      const items = allTypes.slice(0, 10).join(", ");
      lines.push(`Unused types (${allTypes.length}): ${items}`);
    }
    if (allFiles.length > 0) {
      const items = allFiles.slice(0, 10).join(", ");
      lines.push(`Unused files (${allFiles.length}): ${items}`);
    }
    if (allDeps.length > 0) {
      const items = allDeps.slice(0, 10).join(", ");
      lines.push(`Unused dependencies (${allDeps.length}): ${items}`);
    }
    if (allDevDeps.length > 0) {
      const items = allDevDeps.slice(0, 10).join(", ");
      lines.push(`Unused devDependencies (${allDevDeps.length}): ${items}`);
    }

    if (lines.length === 1) {
      lines.push("No unused exports, files, or dependencies found");
    }

    console.log(lines.join("\n"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.log("knip analysis failed — JSON parse error");
    } else {
      console.log(`knip analysis failed — ${err.message}`);
    }
  }
});
