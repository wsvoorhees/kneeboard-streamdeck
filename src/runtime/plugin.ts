import streamDeck from "@elgato/streamdeck";

import {
  ProfileSelect,
  TabSelect,
  PlacementDial,
  PlacementReset,
  Recentre,
  ViewSelect,
  ViewOpacity,
  ShowView,
} from "./actions.ts";
import { closeSession } from "./session.ts";

streamDeck.logger.setLevel("info");
streamDeck.logger.info(
  `openkneeboard-configurator starting: node ${process.version}, pid ${process.pid}`,
);

streamDeck.actions.registerAction(new ProfileSelect());
streamDeck.actions.registerAction(new TabSelect());
streamDeck.actions.registerAction(new PlacementDial());
streamDeck.actions.registerAction(new PlacementReset());
streamDeck.actions.registerAction(new Recentre());
streamDeck.actions.registerAction(new ViewSelect());
streamDeck.actions.registerAction(new ShowView());
streamDeck.actions.registerAction(new ViewOpacity());

// The handle is the only OS resource the plugin holds; release it rather than relying on process
// teardown, since Stream Deck restarts plugins in place during development.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    closeSession();
    process.exit(0);
  });
}

streamDeck.connect();
