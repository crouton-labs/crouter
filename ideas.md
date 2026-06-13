## CLI Builder & Self-Improvement

CLI builder skills — needs to build its own harness for projects (like figuring out alaria-codex cli):
- Brainstorm use cases
- Auto-improves on failure
- Changes the pi harness as it goes?

Something around the agent improving itself as it goes/fixing itself/taking feedback well.

## UI, Dashboards, Views & Tickets

UI library for crouter—make it able to access a UI library so it can build dashboards for itself. I want it to build my own crouter dashboard using crouter's ui tooling. Or actually, it should be a git UI for handling PRs?? Or using ink for TUI version of git handling, TUI for visualizing nodes, TUI for visualizing map, progress of nodes, etc. 

When I start crouter, I want to be able to switch between agent mode, tickets, and dashboards.

- It builds dashboards which are just keybind away from opening. They render stuff from APIs and internal tools. THey each have their own menu.
- Anything opens tickets. I want maybe a unified ticket space per cwd (zone). I can cycle between tickets.

- when terminal agents use ask, that has to bubble up to top.

## Telemetry

- Diff or snapshot at time of user propmt—that way if there are thigns that go wrong, I can see exact state at time of complaint
- 

## Infrastructure & Integration

- nodes can be created in new worktrees, build in grove style secret cloning script, make sure the agent is able to verify
- Needs to integrate with slack. 
- Sends messages to slack with what it's working on. User can message back in thread. 
- Make it run in the cloud (but this can't conflict with this be a replicable system)
- Stop tool needs to be used for real.

## Spec Display & UX

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


#### Random Ideas

App-Data—agent can create projects so nodes within them have hteir own project memories. Like workspaces! We'd have AGENT.md docs at all levels too.

Rules move to docs? Docs taht autoload on reading files??
Memory is sus, maybe replaceable by docs/rules/etc—all of these mds only need a flag essentially on wehther their context auto-loads, and to what degree.



Crazy thought:  what if in order to like reach maximum activation, we had users also very smoothly and elegantly onboard onto a keybind native workflow because users who learn all the keybinds and come to love them can't stand switching because none of their keybinds work and also feel faster. And obviously it's really difficult onboarding keybinds, but because we have such a liquidy product surface and product experience that we can create, it seems feasible that we should be able to onboard them onto keybinds, in which case a potential new philosophy should be that keybinds that we as developers enjoy should also be mirrored to the pre-UI version for the sales version of of this application.


All docs are teh same, episodic vs semantic vs preferrential / behavioral knoweldge is one axis, and auto-loaidng rules is another. 
scale: full context, pointer, searchable only
Before big tasks, search docs/memory/skills/etc. This is something  that scales with orchestration mode. Wehn it scales up, it needs to look at other avenues more (maybe other memories are relevant, for exmaple).


Flatten it out, but have tags instead for organization

lso, we want the user memory dir out of the canvas dir. We can have per-node memory in the canvas, but that's it—the rest belongs in the project dir and the .crouter/memory/ dir.


### Resident/Terminal & Root & Push Updates
Is user node? or are they just I/O?
Every task is indefinite? The user just sets tasks. The agent doesn't really "know" if there will be more work after it does its task. So in some ways, it's last response should always be treated as "final"—it's just that it might submit multiple? 


Need to be able to make sibling agents (alerts the parent what was made/why, subscribes them). That way you can work in subagent and do more.
