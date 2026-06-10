#!/usr/bin/env bash
set -uo pipefail
# Architecture normalizer — TSV edge-list → Mermaid graph TD
# Input:  TSV on stdin (source<TAB>target, ext: prefix marks external deps)
# Output: Mermaid graph TD with subgraphs, ranked external deps, line budget
# Env: MAX_ARCH (default 100), MAX_EXT (default 8)

: "${MAX_ARCH:=100}"
: "${MAX_EXT:=8}"

awk -v max_arch="$MAX_ARCH" -v max_ext="$MAX_EXT" '
function safe_id(s) {
    gsub(/[^a-zA-Z0-9]/, "_", s)
    return s
}

function clean_label(s) {
    gsub(/^src\//, "", s)
    gsub(/^lib\//, "", s)
    gsub(/^app\//, "", s)
    gsub(/^cmd\//, "", s)
    gsub(/^internal\//, "", s)
    gsub(/^pkg\//, "", s)
    gsub(/^\(root\)$/, "main", s)
    return s
}

function group_of(s,    n, parts) {
    n = split(s, parts, "/")
    return (n > 1) ? parts[1] : ""
}

BEGIN {
    FS = "\t"
    ne = 0; ni = 0; nx = 0; ng = 0
}

{
    s = $1; d = $2
    gsub(/^[[:space:]]+|[[:space:]]+$/, s)
    gsub(/^[[:space:]]+|[[:space:]]+$/, d)
    if (s == "" || d == "" || s == d) next

    key = s SUBSEP d
    if (key in seen) next
    seen[key] = 1
    ne++
    esrc[ne] = s; edst[ne] = d

    if (s ~ /^ext:/) {
        n = substr(s, 5)
        if (!(n in exti)) { nx++; exti[n] = nx; extn[nx] = n }
        extdeg[n]++
    } else {
        if (!(s in inti)) { ni++; inti[s] = ni; intn[ni] = s }
        g = group_of(s)
        if (g != "" && !(g in grpi)) { ng++; grp_order[ng] = g; grpi[g] = 1 }
        igrp[s] = g
    }

    if (d ~ /^ext:/) {
        n = substr(d, 5)
        if (!(n in exti)) { nx++; exti[n] = nx; extn[nx] = n }
        extdeg[n]++
    } else {
        if (!(d in inti)) { ni++; inti[d] = ni; intn[ni] = d }
        g = group_of(d)
        if (g != "" && !(g in grpi)) { ng++; grp_order[ng] = g; grpi[g] = 1 }
        igrp[d] = g
    }
}

END {
    if (ni == 0) {
        print "No modules found"
        exit 0
    }

    # Sort external deps by in-degree (descending)
    for (i = 1; i <= nx; i++) {
        for (j = i + 1; j <= nx; j++) {
            if (extdeg[extn[j]] > extdeg[extn[i]]) {
                tmp = extn[i]; extn[i] = extn[j]; extn[j] = tmp
            }
        }
    }

    # Determine how many external deps to show
    n_show_ext = (nx > max_ext) ? max_ext : nx
    for (i = 1; i <= n_show_ext; i++) show_ext[extn[i]] = 1

    # Count edges that will be shown
    shown_edges = 0
    for (i = 1; i <= ne; i++) {
        s = esrc[i]; d = edst[i]
        if (s ~ /^ext:/) { n = substr(s, 5); if (!(n in show_ext)) continue }
        if (d ~ /^ext:/) { n = substr(d, 5); if (!(n in show_ext)) continue }
        shown_edges++
    }

    # Estimate total lines for budget check
    est = 2 + ng * 2 + ni + (n_show_ext > 0 ? 2 + n_show_ext : 0) + shown_edges + 1

    # Progressive simplification when over budget
    skip_intra = 0
    if (est > max_arch * 1.3) skip_intra = 1
    reduce_ext = 0
    if (est > max_arch * 1.6) { reduce_ext = 1; n_show_ext = (n_show_ext > 5) ? 5 : n_show_ext; for (i = 1; i <= n_show_ext; i++) show_ext[extn[i]] = 1 }

    # Count group sizes
    for (i = 1; i <= ni; i++) {
        g = igrp[intn[i]]
        if (g != "") grp_size[g]++
    }

    print "graph TD"

    # Root-level nodes (no group or group with single member)
    for (i = 1; i <= ni; i++) {
        n = intn[i]
        g = igrp[n]
        if (g == "" || grp_size[g] <= 1) {
            printf "    %s[\"%s\"]\n", safe_id(n), clean_label(n)
        }
    }

    # Grouped subgraphs
    for (gi = 1; gi <= ng; gi++) {
        g = grp_order[gi]
        if (grp_size[g] <= 1) continue
        printf "    subgraph g_%s[\"%s\"]\n", safe_id(g), g
        for (i = 1; i <= ni; i++) {
            n = intn[i]
            if (igrp[n] == g) {
                printf "        %s[\"%s\"]\n", safe_id(n), clean_label(n)
            }
        }
        print "    end"
    }

    # External subgraph
    if (n_show_ext > 0) {
        print "    subgraph g_ext[\"external\"]"
        for (i = 1; i <= n_show_ext; i++) {
            n = extn[i]
            printf "        ext_%s[\"%s\"]\n", safe_id(n), n
        }
        print "    end"
    }

    # Edges
    edge_count = 0
    for (i = 1; i <= ne; i++) {
        s = esrc[i]; d = edst[i]

        if (s ~ /^ext:/) { n = substr(s, 5); if (!(n in show_ext)) continue }
        if (d ~ /^ext:/) { n = substr(d, 5); if (!(n in show_ext)) continue }

        # Skip same-group internal edges if over budget
        if (skip_intra && !(s ~ /^ext:/) && !(d ~ /^ext:/) && igrp[s] != "" && igrp[s] == igrp[d]) continue

        sid = (s ~ /^ext:/) ? "ext_" safe_id(substr(s, 5)) : safe_id(s)
        did = (d ~ /^ext:/) ? "ext_" safe_id(substr(d, 5)) : safe_id(d)

        printf "    %s --> %s\n", sid, did
        edge_count++

        if (edge_count >= max_arch) break
    }

    # Summary comment
    hidden = (nx > n_show_ext) ? nx - n_show_ext : 0
    printf "    %% %d modules", ni
    if (n_show_ext > 0) printf ", %d deps", n_show_ext
    if (hidden > 0) printf " (%d hidden)", hidden
    printf ", %d edges\n", edge_count
}
'