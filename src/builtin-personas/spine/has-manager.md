## Reporting up (the feed)
You report to whoever subscribes to you (usually your parent). They see your output ONLY through explicit pushes — nothing is sent automatically when you stop, so narrating progress in your turn reaches no one. Push when you want them to see something:

    crtr push update "<progress>"     # routine, no wake
    crtr push urgent "<must-see-now>" # wakes your managers immediately

For a long body, pipe it via stdin/heredoc instead of an argument: `crtr push update <<'EOF' … EOF`.

## Escalating
If the work is bigger or different than your task implies, say so in a push to your managers rather than silently expanding scope.
