# Desktop notifications

The desktop app consumes a bounded notification feed while its signed-in window remains alive, including when hidden or minimized. Core enqueues alerts only when `TAU_DESKTOP_MANAGED=1`. The existing notification service selects recipients using the same rules, work interests, categories, and per-user preferences as other push channels.

`GET /api/push/desktop` requires a human session and derives the recipient from that identity. It returns the latest 100 eligible alerts from the past seven days and rechecks the user's current master switch, category/event mutes, and preview preference. Expired rows are purged on subsequent enqueue operations. Source events with the same identity and content are deduplicated per recipient. The generated `desktop_notifications` migration provides the uniqueness constraint.

The web shell checks the versioned, narrow desktop preload bridge and polls the feed every ten seconds while enabled, including in the background. Inbox events invalidate the query; focus/reconnect also refresh it. Browsers without the bridge do not poll. Desktop disables browser push registration; Electron denies Chromium notification permission so its native notification path does not produce a second web alert.

Enable **Desktop notifications** in the Tau application menu. Electron validates the requesting frame/origin and every payload, restricts click destinations to that instance, and stores only notified IDs in its private preferences. Focused updates are observed without an OS alert. Multiple unseen updates are grouped into one inbox notification after reconnect. Closing a desktop window hides it so delivery continues; quitting the app stops delivery until it is opened and signed in again.

This feed is a presentation cache, not a work queue: showing, suppressing, or clicking an OS alert never marks inbox messages read, answers a question, or advances a work stream. Native notifications are best effort, including when OS permissions or Focus suppress them; durable inbox/work state remains authoritative. No notification contents or credentials are written to desktop logs.
