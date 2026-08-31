# Names the Herdr pane after the foreground command. No-ops outside Herdr.
#
# Herdr has no "foreground command changed" event, so this hook does the live
# update: preexec names the pane after a real executable, precmd names it
# after the shell once back at the prompt. Plugin events cover tab switches.
#
# bash has no native preexec. DEBUG and PROMPT_COMMAND are shared with atuin,
# bash-preexec, ble.sh, and starship, so this cooperates:
#   * If preexec_functions / precmd_functions already exist, register there.
#   * Otherwise drive precmd from PROMPT_COMMAND and preexec from DEBUG, but
#     only install DEBUG when nothing else holds it.
#
# Source this after prompt and history tools so their arrays already exist.

[[ ${HERDR_ENV:-} == 1 && -n ${HERDR_PANE_ID:-} ]] || return 0
[[ -z ${_herdr_tab_titles_shell:-} ]] || return 0
_herdr_tab_titles_shell=1

_herdr_tab_titles_launch() {
  local launcher="$HOME/.local/bin/herdr-tab-titles"
  [[ -x $launcher ]] || launcher=herdr-tab-titles
  "$launcher" --source process "$@" >/dev/null 2>&1
}

# A file on PATH can name the pane immediately. Aliases, builtins, and `fg`
# are unresolved on the raw line, so sample the live process after a beat.
_herdr_tab_titles_preexec() {
  local word="${1%% *}" kind
  word="${word##*/}"
  kind=$(type -t -- "$word" 2>/dev/null) || true
  if [[ $kind == file ]]; then
    (_herdr_tab_titles_launch --process "$word" &)
  else
    (sleep 0.05; _herdr_tab_titles_launch &)
  fi
}

_herdr_tab_titles_precmd() {
  (_herdr_tab_titles_launch --process bash &)
}

if declare -p preexec_functions >/dev/null 2>&1 || declare -p precmd_functions >/dev/null 2>&1; then
  case " ${preexec_functions[*]} " in *" _herdr_tab_titles_preexec "*) : ;; *) preexec_functions+=(_herdr_tab_titles_preexec) ;; esac
  case " ${precmd_functions[*]} " in *" _herdr_tab_titles_precmd "*) : ;; *) precmd_functions+=(_herdr_tab_titles_precmd) ;; esac
else
  _herdr_tab_titles_fired=1
  _herdr_tab_titles_debug() {
    [[ -n ${COMP_LINE:-} ]] && return
    [[ ${BASH_SUBSHELL:-0} -gt 0 ]] && return
    [[ $_herdr_tab_titles_fired == 1 ]] && return
    case "$BASH_COMMAND" in _herdr_tab_titles_*) return ;; esac
    _herdr_tab_titles_fired=1
    _herdr_tab_titles_preexec "$BASH_COMMAND"
  }

  _herdr_tab_titles_precmd_wrap() {
    local _herdr_tab_titles_st=$?
    _herdr_tab_titles_fired=0
    _herdr_tab_titles_precmd
    return $_herdr_tab_titles_st
  }
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}_herdr_tab_titles_precmd_wrap"

  if [[ -z $(trap -p DEBUG 2>/dev/null) ]]; then
    trap '_herdr_tab_titles_debug' DEBUG
  fi
fi
