//! Quick live check of the AX walk: walk an app's main window by name, print
//! node count + new-field coverage. Usage: cargo run --example ax_dump_check -- Finder
fn main() -> anyhow::Result<()> {
    let name = std::env::args().nth(1).unwrap_or_else(|| "Finder".into());
    if !vibe_extract_core::ax_macos::check_permission(false) {
        anyhow::bail!("no AX permission in this shell");
    }
    let out = std::process::Command::new("pgrep").args(["-x", &name]).output()?;
    let pid: i32 = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().parse()?;
    let node = vibe_extract_core::ax_macos::walk_window(
        pid, vibe_extract_core::ax_macos::WindowSelector::Main, 25)?;
    let mut counts = (0usize, 0usize, 0usize, 0usize); // nodes, with_state, cells, merged_rel
    fn visit(n: &vibe_extract_core::ax_macos::Node, c: &mut (usize, usize, usize, usize)) {
        c.0 += 1;
        if !n.state.is_empty() { c.1 += 1; }
        if n.role == "AXCell" { c.2 += 1; }
        if n.child_source.as_deref().map(|s| s.contains('+')).unwrap_or(false) { c.3 += 1; }
        for k in &n.children { visit(k, c); }
    }
    visit(&node, &mut counts);
    println!("app={name} pid={pid}");
    println!("nodes={} with_state={} cells={} merged_relations={}", counts.0, counts.1, counts.2, counts.3);
    Ok(())
}
