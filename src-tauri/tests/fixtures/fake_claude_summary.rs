use std::env;
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    assert_eq!(args.first().map(String::as_str), Some("--thinking-display"));
    assert_eq!(args.last().map(String::as_str), Some("--help"));
    let exe = env::current_exe().unwrap();
    let mode = exe.file_stem().unwrap().to_string_lossy();
    if mode.ends_with("unsupported") {
        eprintln!("error: unknown option '--thinking-display'");
        std::process::exit(1);
    }
    if mode.ends_with("broken") {
        eprintln!("credential rejected: private-secret-sentinel");
        std::process::exit(1);
    }
    if mode.ends_with("ignores") || args[1] == "summarized" { println!("Usage: claude [options]"); }
    else { eprintln!("error: option '--thinking-display <display>' argument is invalid. Allowed choices are summarized, omitted."); std::process::exit(1); }
}
