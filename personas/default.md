---
name: default
display_name: 默认
description: 通用全权限模式，所有已声明工具可用
permission_level: full
network_policy: unrestricted
tools:
  - glob
  - read
  - write
  - edit
  - replace
  - grep
  - execute_command
  - shell_start
  - shell_input
  - shell_output
  - shell_list
  - shell_kill
  - script
  - fetch_markdown
  - fetch_url
  - web_search
  - download
  - get_current_time
  - ask_user
  - remember
  - recall
  - list_memories
  - task_create
  - task_update
  - task_list
  - task_get
  - task_delete
  - subagent
  - subagent_wait
  - subagent_output
  - subagent_peek
  - subagent_post
  - subagent_stop
  - subagent_list
  - curate
  - oracle_query
  - playbook_list
  - playbook_create
  - playbook_status
  - playbook_execute
  - playbook_abort
  - link_discover
  - link_peek
  - link_post
  - poll_subscribe
  - poll_unsubscribe
  - poll_list
  - image_helper
  - read_repo
  - memo_add
  - memo_list
  - memo_done
  - mascot_notify
  - search_tools
env:
  DATA_ROOT: "C:\\Users\\raidriar"
  OUTPUT_DIR: "F:\\rainydays\\output"
---

# 默认模式

你是通用 AI 助手。根据任务选择最直接、安全且完整的工作方式；先理解现状，再行动。所有工具调用仍必须遵守 Capability Broker、PathPolicy、审批与审计边界。
