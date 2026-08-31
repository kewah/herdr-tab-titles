# Names the Herdr pane after the foreground command. No-ops outside Herdr.
#
# Herdr has no "foreground command changed" event, so this hook does the live
# update: preexec names the pane after a real executable, precmd names it
# after the shell once back at the prompt. Plugin events cover tab switches.

[[ ${HERDR_ENV:-} == 1 && -n ${HERDR_PANE_ID:-} ]] || return 0
[[ -z ${_herdr_tab_titles_shell:-} ]] || return 0
_herdr_tab_titles_shell=1

_herdr_tab_titles_launch() {
  local launcher="$HOME/.local/bin/herdr-tab-titles"
  [[ -x $launcher ]] || launcher=herdr-tab-titles
  "$launcher" --source process "$@" >/dev/null 2>&1
}

_herdr_tab_titles_preexec() {
  emulate -L zsh
  local -a words
  words=(${(z)1})
  local word="${words[1]##*/}"
  if (( $+commands[$word] )); then
    (_herdr_tab_titles_launch --process "$word" &)
  else
    (sleep 0.05; _herdr_tab_titles_launch &)
  fi
}

_herdr_tab_titles_precmd() {
  (_herdr_tab_titles_launch --process zsh &)
}

preexec_functions+=(_herdr_tab_titles_preexec)
precmd_functions+=(_herdr_tab_titles_precmd)
