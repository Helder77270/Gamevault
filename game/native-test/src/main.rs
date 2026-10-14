// GameVault native test "game" — the smallest possible process to exercise
// the native runtime: visible console window, ticks every second, runs
// until closed (or terminated by the launcher on EJECT / resale).

use std::io::Write;
use std::time::Instant;

fn main() {
    // Set by the launcher: the edition / licence this build was opened as
    // (the "Stress Test 500" build embeds this same program).
    let title = std::env::var("GAMEVAULT_TITLE").unwrap_or_default();
    let licence = std::env::var("GAMEVAULT_LICENCE").unwrap_or_default();
    println!("==========================================");
    println!("   GAMEVAULT · NATIVE RUNTIME TEST");
    if !title.is_empty() {
        println!("   Lance comme : {title} · licence #{licence}");
    }
    println!("   Licence verifiee, build dechiffre,");
    println!("   processus lance par le launcher.");
    println!("   Fermez la fenetre ou EJECT pour quitter.");
    println!("==========================================");
    let start = Instant::now();
    loop {
        print!("\r  [RUNNING] {:>5} s ecoulees", start.elapsed().as_secs());
        let _ = std::io::stdout().flush();
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
