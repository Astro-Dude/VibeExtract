//! Check that table rows/cells survive the walk (Finder list view).
fn main() -> anyhow::Result<()> {
    let pid: i32 = std::env::args().nth(1).unwrap().parse()?;
    let node = vibe_extract_core::ax_macos::walk_window(
        pid, vibe_extract_core::ax_macos::WindowSelector::Main, 25)?;
    let mut rows = 0usize; let mut cells = 0usize; let mut texts = 0usize; let mut sel = 0usize;
    fn visit(n: &vibe_extract_core::ax_macos::Node, r: &mut usize, c: &mut usize, t: &mut usize, s: &mut usize) {
        match n.role.as_str() {
            "AXRow" => *r += 1,
            "AXCell" => *c += 1,
            "AXStaticText" => *t += 1,
            _ => {}
        }
        if n.state.iter().any(|x| x == "selected") { *s += 1; }
        for k in &n.children { visit(k, r, c, t, s); }
    }
    visit(&node, &mut rows, &mut cells, &mut texts, &mut sel);
    println!("nodes={} rows={rows} cells={cells} texts={texts} selected={sel}",
             vibe_extract_core::ax_macos::count_nodes(&node));
    Ok(())
}
