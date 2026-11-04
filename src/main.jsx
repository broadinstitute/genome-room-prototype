import { GenomeRoomApp } from "./app/GenomeRoomApp.js";
import "pattern-app-kit/css/base.css";

// The deck app renders into this absolutely-positioned full-bleed container.
const deckContainer = document.createElement("div");
deckContainer.id = "deckContainer";
deckContainer.style.position = "absolute";
deckContainer.style.width = "100%";
deckContainer.style.height = "100%";
document.body.appendChild(deckContainer);

document.body.setAttribute("data-theme", "dark");

const app = new GenomeRoomApp("#deckContainer", null, { initialTheme: "dark" });
app.init(() => app.setTheme("dark"));
