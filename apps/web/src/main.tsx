// Styles load from the entry so they are linked in index.html and paint with the page.
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./styles.css";

// zod has to be told it may not eval before @quantaflow/core builds its schemas at import
// time, and static imports all evaluate before this module's body. So configure first,
// then load the app.
import "./lib/csp";

await import("./boot");
