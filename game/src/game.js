/* GameVault Runner — collect 10 coins, dodge the reds. Pure-shapes Phaser
   game (no external assets: everything must live inside the single file). */

class Main extends Phaser.Scene {
  create() {
    this.score = 0;
    this.gameOver = false;

    const g = this.add.graphics();
    g.fillStyle(0x5cb884).fillRect(0, 0, 28, 28);
    g.generateTexture("player", 28, 28);
    g.clear();
    g.fillStyle(0xd9a441).fillCircle(8, 8, 8);
    g.generateTexture("coin", 16, 16);
    g.clear();
    g.fillStyle(0xd98860).fillRect(0, 0, 24, 24);
    g.generateTexture("enemy", 24, 24);
    g.destroy();

    this.player = this.physics.add.image(400, 225, "player").setCollideWorldBounds(true);
    this.cursors = this.input.keyboard.createCursorKeys();

    this.coins = this.physics.add.group();
    for (let i = 0; i < 8; i++) this.spawnCoin();

    this.enemies = this.physics.add.group();
    for (let i = 0; i < 3; i++) {
      const e = this.enemies.create(Phaser.Math.Between(60, 740), Phaser.Math.Between(60, 120), "enemy");
      e.setVelocity(Phaser.Math.Between(-160, 160), Phaser.Math.Between(90, 170));
      e.setBounce(1).setCollideWorldBounds(true);
    }

    this.physics.add.overlap(this.player, this.coins, (_p, coin) => this.collect(coin));
    this.physics.add.overlap(this.player, this.enemies, () => this.die());

    this.scoreText = this.add.text(12, 8, "Pièces : 0 / 10", { fontSize: "18px", color: "#eceae5" });
    this.add.text(12, 425, "Flèches pour bouger — cartouche GameVault déchiffrée en mémoire", {
      fontSize: "12px",
      color: "#9aa0aa",
    });
  }

  spawnCoin() {
    this.coins.create(Phaser.Math.Between(40, 760), Phaser.Math.Between(60, 410), "coin");
  }

  collect(coin) {
    if (this.gameOver) return;
    coin.destroy();
    this.score++;
    this.scoreText.setText(`Pièces : ${this.score} / 10`);
    if (this.score >= 10) return this.win();
    this.spawnCoin();
  }

  banner(lines, color) {
    this.physics.pause();
    this.gameOver = true;
    this.add.rectangle(400, 225, 800, 450, 0x0b0d11, 0.82);
    lines.forEach((txt, i) =>
      this.add
        .text(400, 190 + i * 34, txt, { fontSize: i === 0 ? "30px" : "16px", color: i === 0 ? color : "#9aa0aa" })
        .setOrigin(0.5),
    );
    this.input.keyboard.once("keydown-SPACE", () => this.scene.restart());
  }

  win() {
    this.banner(["Licence vérifiée — GG !", "Propriété prouvée on-chain, jeu déchiffré en RAM.", "ESPACE pour rejouer"], "#d9a441");
  }

  die() {
    this.banner(["Touché !", "ESPACE pour réessayer"], "#d98860");
  }

  update() {
    if (this.gameOver) return;
    const speed = 240;
    this.player.setVelocity(
      (this.cursors.left.isDown ? -speed : 0) + (this.cursors.right.isDown ? speed : 0),
      (this.cursors.up.isDown ? -speed : 0) + (this.cursors.down.isDown ? speed : 0),
    );
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 450,
  backgroundColor: "#14171c",
  physics: { default: "arcade" },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Main,
});
