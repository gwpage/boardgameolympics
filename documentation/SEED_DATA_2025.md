# Seed Data — 2025 Event (Unarchived Test Data)

This data should be loaded into the database for testing purposes. It represents the 2025 event which has not yet been archived. The developer can use this to build and test the UI against realistic data.

---

## Event Settings (2025)

| Field | Value |
|-------|-------|
| Year | 2025 |
| Event Date | February 15, 2025 |
| Theme Title | Board Games |
| Theme Description | This year, your country IS a board game. Pick your favorite tabletop classic and represent it with pride. May the best game win! |

---

## Users & Country Claims

Flags are blank (`null`) for all test users. Registration dates are random between Jan 15 – Feb 14, 2025. Since this is a past event, most users have RSVP'd — a few are set to "not attending" or "no response" to give the admin views realistic variety.

| # | Name | Email | Role | Country (Board Game) | RSVP | Registered |
|---|------|-------|------|---------------------|------|------------|
| 0 | Wiley Page | gwpage@gmail.com | admin | Monopoly | attending | 2025-01-15 |
| 1 | Marcus Chen | marcus.chen@fakemail.com | user | Catan | attending | 2025-01-15 |
| 2 | Priya Sharma | priya.sharma@fakemail.com | user | Ticket to Ride | attending | 2025-01-16 |
| 3 | Jordan McAllister | jordan.mcallister@fakemail.com | user | Wingspan | attending | 2025-01-18 |
| 4 | Tessa Björk | tessa.bjork@fakemail.com | user | Azul | attending | 2025-01-19 |
| 5 | Dave Kowalski | dave.kowalski@fakemail.com | user | Pandemic | attending | 2025-01-21 |
| 6 | Lina Ferreira | lina.ferreira@fakemail.com | user | Scythe | attending | 2025-01-22 |
| 7 | Sam Okafor | sam.okafor@fakemail.com | user | Codenames | attending | 2025-01-24 |
| 8 | Rachel Kim | rachel.kim@fakemail.com | user | Terraforming Mars | attending | 2025-01-25 |
| 9 | Eli Brandt | eli.brandt@fakemail.com | user | Dominion | not_attending | 2025-01-27 |
| 10 | Noor Al-Rashid | noor.alrashid@fakemail.com | user | Carcassonne | attending | 2025-01-28 |
| 11 | Casey Tremblay | casey.tremblay@fakemail.com | user | Spirit Island | attending | 2025-01-30 |
| 12 | Anika Patel | anika.patel@fakemail.com | user | Splendor | attending | 2025-02-01 |
| 13 | Owen Gallagher | owen.gallagher@fakemail.com | user | Root | attending | 2025-02-02 |
| 14 | Mei-Ling Wu | meiling.wu@fakemail.com | user | Everdell | attending | 2025-02-04 |
| 15 | Tobias Engström | tobias.engstrom@fakemail.com | user | Gloomhaven | attending | 2025-02-05 |
| 16 | Harper Reeves | harper.reeves@fakemail.com | user | 7 Wonders | not_attending | 2025-02-07 |
| 17 | Diego Morales | diego.morales@fakemail.com | user | Chess | attending | 2025-02-08 |
| 18 | Freya Nakamura | freya.nakamura@fakemail.com | user | Betrayal at House on the Hill | attending | 2025-02-10 |
| 19 | Callum O'Brien | callum.obrien@fakemail.com | user | King of Tokyo | no_response | 2025-02-12 |
| 20 | Zara Petrov | zara.petrov@fakemail.com | user | Clue | attending | 2025-02-14 |

---

## Messages

Random messages posted to the message board. Timestamps should fall on or after the user's registration date.

| User | Message | Timestamp |
|------|---------|-----------|
| Marcus Chen | First one here! Let's gooo | 2025-01-15 |
| Priya Sharma | Ticket to Ride is going to crush it this year | 2025-01-17 |
| Jordan McAllister | Wingspan gang rise up | 2025-01-18 |
| Dave Kowalski | Pandemic feels oddly appropriate for the times | 2025-01-21 |
| Tessa Björk | Does anyone know if there's parking nearby? | 2025-01-22 |
| Sam Okafor | Can't wait to see everyone! | 2025-01-25 |
| Lina Ferreira | Scythe will conquer all | 2025-01-26 |
| Rachel Kim | Terraforming Mars — because why settle for one planet? | 2025-01-28 |
| Marcus Chen | Who else is bringing snacks? | 2025-01-30 |
| Noor Al-Rashid | Carcassonne forever | 2025-01-30 |
| Casey Tremblay | Spirit Island is the best co-op game ever made, fight me | 2025-02-01 |
| Owen Gallagher | Root is basically a war crime simulator and I'm here for it | 2025-02-03 |
| Anika Patel | So excited for this! My third year in a row | 2025-02-04 |
| Tobias Engström | Gloomhaven crew — who wants to form a party? | 2025-02-06 |
| Harper Reeves | 7 Wonders, 7 victories | 2025-02-08 |
| Diego Morales | Chess is the OG board game. Respect the classics | 2025-02-09 |
| Freya Nakamura | Betrayal at House on the Hill because I like chaos | 2025-02-11 |
| Zara Petrov | Last minute signup! Wouldn't miss it though | 2025-02-14 |
| Callum O'Brien | Anyone want to carpool from downtown? | 2025-02-13 |
| Mei-Ling Wu | Everdell is so pretty. That's my whole argument | 2025-02-05 |

---

## Message Likes (Meeples)

Sample likes to populate the meeple counts. Each row means "this user liked this message."

| Message (by) | Liked by |
|--------------|----------|
| Marcus Chen — "First one here! Let's gooo" | Priya Sharma, Jordan McAllister, Wiley Page, Sam Okafor, Anika Patel |
| Priya Sharma — "Ticket to Ride is going to crush it" | Marcus Chen, Tessa Björk |
| Dave Kowalski — "Pandemic feels oddly appropriate" | Lina Ferreira, Rachel Kim, Noor Al-Rashid, Casey Tremblay, Owen Gallagher, Diego Morales |
| Sam Okafor — "Can't wait to see everyone!" | Marcus Chen, Priya Sharma, Wiley Page, Anika Patel, Zara Petrov, Freya Nakamura, Tessa Björk |
| Lina Ferreira — "Scythe will conquer all" | Dave Kowalski, Tobias Engström |
| Rachel Kim — "Terraforming Mars — because why settle for one planet?" | Marcus Chen, Lina Ferreira, Mei-Ling Wu |
| Casey Tremblay — "Spirit Island is the best co-op game ever made, fight me" | Owen Gallagher, Tobias Engström, Wiley Page, Dave Kowalski |
| Owen Gallagher — "Root is basically a war crime simulator" | Casey Tremblay, Freya Nakamura, Callum O'Brien, Wiley Page, Marcus Chen, Lina Ferreira, Sam Okafor |
| Mei-Ling Wu — "Everdell is so pretty. That's my whole argument" | Anika Patel, Harper Reeves, Priya Sharma, Tessa Björk, Freya Nakamura |
| Diego Morales — "Chess is the OG board game" | Wiley Page, Noor Al-Rashid |
| Marcus Chen — "Who else is bringing snacks?" | Priya Sharma, Sam Okafor, Anika Patel, Zara Petrov |
| Callum O'Brien — "Anyone want to carpool from downtown?" | Freya Nakamura, Zara Petrov |
