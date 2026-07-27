// The single client-side store: hydrates a BoardSnapshot,
// applies WS deltas, exposes signals + optimistic mutation functions.
// Contract consumed by the shell/task-detail agent — keep these exports stable.
//
//   connection   connected, hydrated, lastSeq, pendingCount, connect(), disconnect()
//   entities     spaces, lists, tasks, subtasks, comments, users, me, automationRules
//                (a task in the store is a StoreTask: snapshot fields always,
//                 description/startDate/createdBy/closedAt/clickupId once a
//                 detail fetch or a delta has landed them)
//   lookups      listById, spaceById, userById, statusById, listsBySpace, firstList
//   derived      tasksByListAndStatus(listId), listBucket(listId), subtaskProgress(id)
//   mutations    createTask, updateTask, moveTask, toggleSubtask, createSubtask,
//                addComment, deleteTask, fetchTaskDetail, prefetchTaskDetail,
//                createSpace, updateSpace, createList, updateList
//
// Mutations are optimistic: they patch the signals first, then reconcile with
// the server's answer (or roll back and toast on failure).

export {
  // connection
  connected,
  hydrated,
  lastSeq,
  pendingCount,
  // entities
  spaces,
  lists,
  tasks,
  subtasks,
  comments,
  users,
  me,
  automationRules,
  // lookups
  listById,
  spaceById,
  userById,
  statusById,
  listsBySpace,
  firstList,
  // derived + helpers
  tasksByListAndStatus,
  listBucket,
  subtaskProgress,
  findStatus,
  openStatus,
  type StatusColumns,
  type StoreTask,
} from "./state.js";

export { hydrate, applyDeltas } from "./apply.js";
export { connect, disconnect } from "./ws.js";
export {
  createTask,
  updateTask,
  moveTask,
  setSubtaskAssignee,
  toggleSubtask,
  createSubtask,
  addComment,
  deleteTask,
  fetchTaskDetail,
  prefetchTaskDetail,
  createSpace,
  updateSpace,
  createList,
  updateList,
} from "./mutations.js";
