CLI builder skills — needs to build its own harness for projects (like figuring out alaria-codex cli):
- Brainstorm use cases
- Auto-improves on failure
- Changes the pi harness as it goes?


UI library for crouter—make it able to access a UI library so it can build dashboards for itself. I want it to build my own crouter dashboard using crouter's ui tooling. Or actually, it should be a git UI for handling PRs?? Or using ink for TUI version of git handling, TUI for visualizing nodes, TUI for visualizing map, progress of nodes, etc. 

When I start crouter, I want to be able to switch between agent mode, tickets, and dashboards.

- It builds dashboards which are just keybind away from opening. They render stuff from APIs and internal tools. THey each have their own menu.
- Anything opens tickets. I want maybe a unified ticket space per cwd (zone). I can cycle between tickets.

- when terminal agents use ask, that has to bubble up to top.


Telemetry
- Diff or snapshot at time of user propmt—that way if there are thigns that go wrong, I can see exact state at time of complaint
- 

Something around the agent improving itself as it goes/fixing itself/taking feedback well.


- nodes can be created in new worktrees, build in grove style secret cloning script, make sure the agent is able to verify
- Needs to integrate with slack. 
- Sends messages to slack with what it's working on. User can message back in thread. 
- Make it run in the cloud (but this can't conflict with this be a replicable system)
- Stop tool needs to be used for real.

Some way of going through conversation history and extracting philosophy/good ideas/idea-savings
- Make it more pleasant to understand your spec
Progressive disclosure: Diagram -> slightly more in depth -> biggest risks -> context around design. Non TUI spec display, use shared components

- The only things it surfaces are things it calls "surface to user" on?
- Want to create "perfect user experiences". User downloads, has no idea what's going on, suddenly they have a custom built app for THEM.

## Scheduled/OpenClaw
- Resident nodes are "persistant personalities"? Need something that learns over time. An "open claw instance". Scheduled items that are persistent are a certain kind of persona—a "human" persona. They should have directives on their memory, receiving feedback, etc. these types of scheduled nodes should also probalby try to make their lives more efficient by writing scripts to do what they do. They should be focused on memory/context saving, optimization via scripts, etc. They should be interactible with user still via human probably

## Northlight Directive

### Philosophies

- Philosophy-driven development, and speed-driven development: how can you make the thing that sings? What is a product that is 10x more beautiful than anything that exists? build the best bones in thew world, and the tallest giant will be made.
- I cannot let myself get idea-debted by zigging. Build what you know will exist when you see it.
- Should be as good for sales as it is for dev
- Should be forever "elegant"
- Take your time to mull over features. Let your subconscious sit with it
- Study UX patterns
- This needs to be able to support any view, inbox pattern, or chat surface.
- I will not concern myself with cost
- Updates need to be painless/smooth. It needs to be easy to push updates
- Agent needs to be highly decoupled from business.

### To Do
Most Critical:
Prove it's spicy
- UI so it looks/feels like northlight, cum-worthy experience
  - Views
  - Chat
  - Inbox
- Focus on the magic sauce: An experience that matches user intent
- Power of the system: make it really fucking good
- Amorphous view/schedules/
- Better view tech: cacheing?
- Contractors have ephemeral views


- Make sure agent can interface with views like they are another app. Should be able to query its gigascripts/internal logic. Views should be MVC, and the agent should be able to directly access model. 
- Apps need local db.

- Apps my schedule work and put them in dbs places, though scheduled nodes may also do stuff like this, and users may build apps off of scheduled nodes? Let agent decide


CALL OUT: Load up cache—we want a beautiful experience (e.g. click drag over region and chat opens up), beautiful functionality. utter elegance.

- Scheduled stuff needs a shared place everything goes
  - Have dir for dbs etc


- Understand Pi agent at a deeper level
- Think about how permissions/application-ized version of Pi would look like

### What Northlight Needs
- Easily installed
- Ratelimiting on the new format
- Shared databases, for example
- Borg functions
- Hive functions
- Kondo: build an app
- Liquid onboarding experience
- Frontend
  - Has to also be pleasant for developers
    - Expand human so when crtr launched with "--ui" flag flipped, it uses that mode. Needs to be modular and cleanly separated
    - Maybe a "sales" mode too where the system prompting is slightly tweaked?
- App installation—users and us need to be able to publish apps for this world.

