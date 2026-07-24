/* GameVault Snake — grid classic, pure shapes. Eat 15, don't bite yourself. */

const CELL = 22;
const COLS = 34;
const ROWS = 19;

class Main extends Phaser.Scene {
  create() {
    this.gfx = this.add.graphics();
    this.scoreText = this.add.text(10, 6, "", { fontSize: "16px", color: "#eceae5" });
    this.add.text(10, 425, "Flèches — cartouche GameVault déchiffrée en mémoire", {
      fontSize: "12px",
      color: "#9aa0aa",
    });
    this.input.keyboard.on("keydown", (e) => this.onKey(e));
    this.reset();
    this.timer = this.time.addEvent({ delay: 110, loop: true, callback: () => this.tick() });
  }

  reset() {
    this.snake = [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }];
    this.dir = { x: 1, y: 0 };
    this.nextDir = this.dir;
    this.score = 0;
    this.dead = false;
    this.won = false;
    this.placeFood();
    this.draw();
  }

  onKey(e) {
    const dirs = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
    };
    const d = dirs[e.key];
    if (d && (d.x !== -this.dir.x || d.y !== -this.dir.y)) this.nextDir = d;
    if (e.code === "Space" && (this.dead || this.won)) this.reset();
  }

  placeFood() {
    do {
      this.food = { x: Phaser.Math.Between(0, COLS - 1), y: Phaser.Math.Between(0, ROWS - 1) };
    } while (this.snake.some((s) => s.x === this.food.x && s.y === this.food.y));
  }

  tick() {
    if (this.dead || this.won) return;
    this.dir = this.nextDir;
    const head = { x: this.snake[0].x + this.dir.x, y: this.snake[0].y + this.dir.y };
    const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
    if (hitWall || this.snake.some((s) => s.x === head.x && s.y === head.y)) {
      this.dead = true;
      return this.draw();
    }
    this.snake.unshift(head);
    if (head.x === this.food.x && head.y === this.food.y) {
      this.score++;
      if (this.score >= 15) {
        this.won = true;
        return this.draw();
      }
      this.placeFood();
    } else {
      this.snake.pop();
    }
    this.draw();
  }

  draw() {
    const g = this.gfx;
    g.clear();
    g.fillStyle(0x1b2028).fillRect(0, 28, COLS * CELL, ROWS * CELL);
    g.fillStyle(0xd9a441).fillRect(this.food.x * CELL + 3, this.food.y * CELL + 31, CELL - 6, CELL - 6);
    this.snake.forEach((s, i) => {
      g.fillStyle(i === 0 ? 0x7ddba3 : 0x5cb884);
      g.fillRect(s.x * CELL + 1, s.y * CELL + 29, CELL - 2, CELL - 2);
    });
    this.scoreText.setText(`Pommes : ${this.score} / 15`);
    if (this.dead || this.won) {
      g.fillStyle(0x0b0d11, 0.82).fillRect(0, 0, 800, 450);
      const msg = this.won ? "Licence vérifiée — GG !" : "Croqué !";
      this.add.text(400, 200, msg, { fontSize: "30px", color: this.won ? "#d9a441" : "#d98860" }).setOrigin(0.5);
      this.add.text(400, 240, "ESPACE pour rejouer", { fontSize: "16px", color: "#9aa0aa" }).setOrigin(0.5);
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 450,
  backgroundColor: "#14171c",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Main,
});
