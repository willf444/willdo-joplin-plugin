import joplin from 'api';
import { MenuItemLocation, SettingItemType } from 'api/types';

type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

type Task = {
	id: string;
	title: string;
	completed: boolean;
	createdAt: string;
	dueAt?: string;
	noteId?: string;
	noteTitle?: string;
	joplinTodoId?: string;
	recurrence?: Recurrence;
};

const TASKS_KEY = 'willdo.tasks';
const MIRROR_FOLDER_TITLE = 'Tarefas WillDo';

function uid() {
	return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function loadTasks(): Promise<Task[]> {
	const raw = await joplin.settings.value(TASKS_KEY);
	if (!raw || typeof raw !== 'string') return [];
	try {
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function saveTasks(tasks: Task[]) {
	await joplin.settings.setValue(TASKS_KEY, JSON.stringify(tasks));
}

function validDueTime(dueAt?: string): number {
	if (!dueAt) return 0;
	const time = new Date(dueAt).getTime();
	return Number.isFinite(time) ? time : 0;
}

async function getWillDoFolderId(): Promise<string> {
	const folders = await joplin.data.get(['folders'], {
		fields: ['id', 'title'],
		limit: 100,
	});

	const existing = folders?.items?.find((folder: any) => folder.title === MIRROR_FOLDER_TITLE);
	if (existing?.id) return existing.id;

	const created = await joplin.data.post(['folders'], null, {
		title: MIRROR_FOLDER_TITLE,
	});

	if (!created?.id) {
		throw new Error('WillDo: não foi possível criar o caderno Tarefas WillDo.');
	}

	return created.id;
}

function buildTodoBody(task: Task): string {
	return 'Evite editar, nota criada pelo plugin WillDo.';
}

async function deleteTodoMirror(task: Task): Promise<Task> {
	if (!task.joplinTodoId) return task;

	try {
		await joplin.data.delete(['notes', task.joplinTodoId]);
	} catch {}

	return {
		...task,
		joplinTodoId: '',
	};
}

async function syncTodoMirror(task: Task): Promise<Task> {
	const dueTime = validDueTime(task.dueAt);
	const parent_id = await getWillDoFolderId();

	const payload = {
		parent_id,
		title: `[WillDo] ${task.title}`,
		body: buildTodoBody(task),
		is_todo: 1,
		todo_due: dueTime || 0,
		todo_completed: task.completed ? Date.now() : 0,
		application_data: JSON.stringify({
			app: 'WillDo',
			taskId: task.id,
			recurrence: normalizeRecurrence(task.recurrence),
			noteId: task.noteId || '',
			noteTitle: task.noteTitle || '',
		}),
	};

	if (task.joplinTodoId) {
		try {
			await joplin.data.put(['notes', task.joplinTodoId], null, payload);
			return task;
		} catch {}
	}

	const created = await joplin.data.post(['notes'], null, payload);

	return {
		...task,
		joplinTodoId: created?.id || '',
	};
}

function parseWillDoTaskFromNote(note: any): Task | null {
	if (!note || note.is_todo !== 1) return null;

	let appData: any = {};
	try {
		appData = note.application_data ? JSON.parse(note.application_data) : {};
	} catch {
		appData = {};
	}

	if (appData?.app !== 'WillDo') return null;

	const title = String(note.title || '').replace(/^\[WillDo\]\s*/, '').trim();
	if (!title) return null;

	const dueMs = Number(note.todo_due || 0);
	const completedMs = Number(note.todo_completed || 0);

	return {
		id: String(appData.taskId || note.id),
		title,
		completed: completedMs > 0,
		createdAt: note.created_time ? new Date(note.created_time).toISOString() : new Date().toISOString(),
		dueAt: dueMs > 0 ? new Date(dueMs).toISOString() : '',
		noteId: String(appData.noteId || ''),
		noteTitle: String(appData.noteTitle || ''),
		joplinTodoId: String(note.id || ''),
		recurrence: normalizeRecurrence(appData.recurrence),
	};
}

async function listWillDoMirrorNotes(): Promise<any[]> {
	const folderId = await getWillDoFolderId();
	const all: any[] = [];
	let page = 1;

	while (true) {
		const result = await joplin.data.get(['folders', folderId, 'notes'], {
			fields: ['id', 'title', 'is_todo', 'todo_due', 'todo_completed', 'application_data', 'created_time', 'updated_time'],
			limit: 100,
			page,
		});

		all.push(...(result?.items || []));

		if (!result?.has_more) break;
		page++;
	}

	return all;
}

async function reconcileWillDoTasks(): Promise<Task[]> {
	const localTasks = await loadTasks();
	const byId = new Map<string, Task>();

	for (const task of localTasks) {
		byId.set(task.id, task);
	}

	const notes = await listWillDoMirrorNotes();

	for (const note of notes) {
		const fromNote = parseWillDoTaskFromNote(note);
		if (!fromNote) continue;

		const existing = byId.get(fromNote.id);

		byId.set(fromNote.id, {
			...fromNote,
			recurrence: normalizeRecurrence(existing?.recurrence || fromNote.recurrence),
			noteId: existing?.noteId || fromNote.noteId,
			noteTitle: existing?.noteTitle || fromNote.noteTitle,
		});
	}

	const reconciled: Task[] = [];

	for (const task of byId.values()) {
		reconciled.push(await syncTodoMirror(task));
	}

	await saveTasks(reconciled);
	return reconciled;
}


function normalizeRecurrence(value?: string): Recurrence {
	if (value === 'daily') return 'daily';
	if (value === 'weekly') return 'weekly';
	if (value === 'monthly') return 'monthly';
	if (value === 'yearly') return 'yearly';
	return 'none';
}

function formatRecurrence(value?: string): string {
	const recurrence = normalizeRecurrence(value);
	if (recurrence === 'daily') return 'Diária';
	if (recurrence === 'weekly') return 'Semanal';
	if (recurrence === 'monthly') return 'Mensal';
	if (recurrence === 'yearly') return 'Anual';
	return '';
}

function addMonthsClamped(date: Date, months: number): Date {
	const next = new Date(date.getTime());
	const originalDay = next.getDate();

	next.setDate(1);
	next.setMonth(next.getMonth() + months);

	const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
	next.setDate(Math.min(originalDay, lastDay));

	return next;
}

function addRecurrenceOnce(date: Date, recurrence: Recurrence): Date {
	if (recurrence === 'daily') {
		const next = new Date(date.getTime());
		next.setDate(next.getDate() + 1);
		return next;
	}

	if (recurrence === 'weekly') {
		const next = new Date(date.getTime());
		next.setDate(next.getDate() + 7);
		return next;
	}

	if (recurrence === 'monthly') {
		return addMonthsClamped(date, 1);
	}

	if (recurrence === 'yearly') {
		return addMonthsClamped(date, 12);
	}

	return date;
}

function nextRecurringDue(dueAt: string, recurrenceValue?: string): string {
	const recurrence = normalizeRecurrence(recurrenceValue);
	const current = new Date(dueAt);

	if (recurrence === 'none' || isNaN(current.getTime())) return dueAt;

	let next = addRecurrenceOnce(current, recurrence);
	const now = new Date();

	for (let i = 0; i < 500 && next.getTime() <= now.getTime(); i++) {
		next = addRecurrenceOnce(next, recurrence);
	}

	return next.toISOString();
}

function escapeHtml(value: string): string {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function formatDue(dueAt?: string) {
	if (!dueAt) return 'Sem data';

	const date = new Date(dueAt);
	if (isNaN(date.getTime())) return 'Sem data';

	const now = new Date();
	const sameDay =
		date.getDate() === now.getDate() &&
		date.getMonth() === now.getMonth() &&
		date.getFullYear() === now.getFullYear();

	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	const isTomorrow =
		date.getDate() === tomorrow.getDate() &&
		date.getMonth() === tomorrow.getMonth() &&
		date.getFullYear() === tomorrow.getFullYear();

	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const mo = String(date.getMonth() + 1).padStart(2, '0');
	const yy = date.getFullYear();

	if (sameDay) return `Hoje às ${hh}:${mm}`;
	if (isTomorrow) return `Amanhã às ${hh}:${mm}`;
	if (yy === now.getFullYear()) return `${dd}/${mo} às ${hh}:${mm}`;
	return `${dd}/${mo}/${yy} às ${hh}:${mm}`;
}

function formatDueInput(dueAt?: string) {
	if (!dueAt) return '';
	const date = new Date(dueAt);
	if (isNaN(date.getTime())) return '';
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const hh = String(date.getHours()).padStart(2, '0');
	const mi = String(date.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function sortTasks(tasks: Task[]) {
	return [...tasks].sort((a, b) => {
		if (a.completed !== b.completed) return a.completed ? 1 : -1;

		const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
		const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;

		if (a.completed && b.completed) {
			return (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0);
		}

		if (aDue !== bDue) return aDue - bDue;
		return a.title.localeCompare(b.title, 'pt-BR');
	});
}

function renderTaskItem(task: Task) {
	const titleEsc = escapeHtml(task.title);
	const dueLabel = escapeHtml(formatDue(task.dueAt));
	const dueInput = escapeHtml(formatDueInput(task.dueAt));
	const noteTitle = escapeHtml(task.noteTitle || '');
	const recurrence = normalizeRecurrence(task.recurrence);
	const recurrenceEsc = escapeHtml(recurrence);
	const recurrenceText = formatRecurrence(recurrence);

	const metaParts = [formatDue(task.dueAt)];
	if (recurrenceText) metaParts.push(recurrenceText);
	if (task.noteTitle) metaParts.push(`Nota: ${task.noteTitle}`);
	const metaText = metaParts.join(' • ');

	const searchText = escapeHtml(
		`${task.title} ${formatDue(task.dueAt)} ${recurrenceText} ${task.noteTitle || ''}`.toLowerCase()
	);

	return `
		<div class="item" data-id="${task.id}" data-search="${searchText}">
			<label class="row">
				<input type="checkbox" data-action="toggle" data-id="${task.id}" ${task.completed ? 'checked' : ''} />
				<span class="item-title ${task.completed ? 'done' : ''}">${titleEsc}</span>
			</label>

			<div class="item-meta">${escapeHtml(metaText)}</div>

			<div class="actions">
				${task.noteId ? `<button class="ghost" data-action="open-note" data-id="${task.id}">Abrir nota</button>` : ''}
				<button class="ghost" data-action="edit" data-id="${task.id}" data-title="${titleEsc}" data-due="${dueInput}" data-recurrence="${recurrenceEsc}">Editar</button>
				<button class="ghost danger" data-action="delete" data-id="${task.id}">Excluir</button>
			</div>

			<div class="edit-box hidden">
				<input class="edit-title" type="text" value="${titleEsc}" placeholder="Título da tarefa" />
				<input class="edit-due" type="datetime-local" value="${dueInput}" />
				<select class="edit-recurrence">
					<option value="none" ${recurrence === 'none' ? 'selected' : ''}>Sem recorrência</option>
					<option value="daily" ${recurrence === 'daily' ? 'selected' : ''}>Diária</option>
					<option value="weekly" ${recurrence === 'weekly' ? 'selected' : ''}>Semanal</option>
					<option value="monthly" ${recurrence === 'monthly' ? 'selected' : ''}>Mensal</option>
					<option value="yearly" ${recurrence === 'yearly' ? 'selected' : ''}>Anual</option>
				</select>

				<div class="note-box">
					<div class="note-current">${task.noteTitle ? `Nota vinculada: ${noteTitle}` : 'Sem nota vinculada'}</div>
					<div class="edit-actions">
						<button class="ghost" data-action="link-current-note" data-id="${task.id}">Usar nota aberta</button>
						<button class="ghost" data-action="clear-note" data-id="${task.id}">Remover vínculo</button>
					</div>
				</div>

				<div class="edit-actions">
					<button class="ghost" data-action="cancel-edit" data-id="${task.id}">Cancelar</button>
					<button data-action="save-edit" data-id="${task.id}">Salvar</button>
				</div>
			</div>
		</div>
	`;
}

function renderTasks(tasks: Task[]) {
	const ordered = sortTasks(tasks);
	const pending = ordered.filter(t => !t.completed);
	const completed = ordered.filter(t => t.completed);

	const renderList = (items: Task[], done: boolean) => {
		if (!items.length) {
			return `<div class="empty">${done ? 'Nenhuma concluída.' : 'Nenhuma pendente.'}</div>`;
		}
		return items.map(renderTaskItem).join('');
	};

	return `
		<!doctype html>
		<html lang="pt-BR">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<style>
				* { box-sizing: border-box; }
				html {
					min-height: 100%;
					overflow-y: auto;
				}
				body {
					margin: 0;
					padding: 12px;
					padding-bottom: 96px;
					font-family: Arial, sans-serif;
					background: #f5f7fb;
					color: #111827;
					overflow-y: auto;
				}
				.wrap {
					display: flex;
					flex-direction: column;
					gap: 12px;
					padding-bottom: 96px;
				}
				.card {
					background: #ffffff;
					border: 1px solid #dbe3ec;
					border-radius: 8px;
					padding: 12px;
				}
				h1 {
					font-size: 18px;
					margin: 0 0 8px 0;
				}
				h2 {
					font-size: 14px;
					margin: 0 0 8px 0;
				}
				.muted {
					color: #64748b;
					font-size: 12px;
				}
				.quick, .search {
					display: flex;
					gap: 8px;
				}
				input[type="text"], input[type="datetime-local"], select {
					flex: 1;
					padding: 8px;
					border: 1px solid #cbd5e1;
					border-radius: 6px;
					font-size: 14px;
				}
				button {
					padding: 8px 12px;
					border: none;
					border-radius: 6px;
					background: #2563eb;
					color: white;
					font-weight: 600;
					cursor: pointer;
				}
				button:hover {
					background: #1d4ed8;
				}
				.ghost {
					background: #e5e7eb;
					color: #111827;
					padding: 6px 10px;
					font-size: 12px;
				}
				.ghost:hover {
					background: #d1d5db;
				}
				.danger {
					background: #efefef;
				}
				.split {
					display: grid;
					grid-template-columns: 1fr;
					gap: 12px;
				}
				.list {
					display: flex;
					flex-direction: column;
					gap: 8px;
				}
				.item {
					background: #fff;
					border: 1px solid #e5e7eb;
					border-radius: 8px;
					padding: 10px;
				}
				.item.search-match {
					border: 2px solid #2563eb;
					background: #eff6ff;
				}
				.row {
					display: flex;
					align-items: center;
					gap: 8px;
				}
				.item-title {
					font-weight: 700;
				}
				.item-title.done {
					text-decoration: line-through;
					color: #6b7280;
				}
				.item-meta {
					margin-top: 6px;
					color: #64748b;
					font-size: 12px;
				}
				.actions, .edit-actions {
					margin-top: 8px;
					display: flex;
					justify-content: flex-end;
					gap: 8px;
				}
				.edit-box {
					margin-top: 10px;
					padding-top: 10px;
					border-top: 1px solid #e5e7eb;
					display: flex;
					flex-direction: column;
					gap: 8px;
				}
				.note-box {
					background: #f8fafc;
					border: 1px solid #e5e7eb;
					border-radius: 6px;
					padding: 8px;
				}
				.note-current {
					font-size: 12px;
					color: #475569;
				}
				.donation-box {
					margin-top: 12px;
					padding-top: 12px;
					border-top: 1px solid #e5e7eb;
					display: flex;
					flex-direction: column;
					gap: 8px;
				}
				.donation-line {
					font-size: 13px;
					color: #334155;
					font-weight: 600;
				}
				.donation-line-en {
					margin-top: 2px;
				}
				.donation-actions {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
				}
				.donation-status {
					min-height: 16px;
					font-size: 12px;
					color: #64748b;
				}
				.empty {
					color: #64748b;
					font-size: 13px;
				}
				.hidden {
					display: none !important;
				}
			
/* WILLDO_MOBILE_ADD_ROW_FIX */
div:has(> #quickTask):has(> #addBtn) {
	display: flex;
	gap: 10px;
	width: 100%;
	max-width: 100%;
	align-items: stretch;
	box-sizing: border-box;
}

#quickTask {
	flex: 1 1 auto;
	min-width: 0;
	width: 100%;
	box-sizing: border-box;
}

#addBtn {
	flex: 0 0 auto;
	white-space: nowrap;
	box-sizing: border-box;
}

</style>
		</head>
		<body>
			<div class="wrap">
				<div class="card">
					<h1>WillDo</h1>
					<div class="muted">Cria com Enter e edita só o que precisar.</div>
					<div class="donation-box">
						<div class="donation-line">Gostou do plugin? Contribua com um pix email:</div>
						<div class="donation-actions">
							<button class="ghost" id="pixBtn" type="button">PIX: will-pague@jim.com</button>
						</div>
						<div class="donation-line donation-line-en">Buy me a coffee:</div>
						<div class="donation-actions">
							<button class="ghost" id="paypalBtn" type="button">PayPal</button>
						</div>
						<div class="donation-status" id="donationStatus"></div>
					</div>
				</div>

				<div class="card">
					<div class="quick">
						<input id="quickTask" type="text" placeholder="Digite a tarefa..." />
						<button id="addBtn">Adicionar</button>
					</div>
				</div>

				<div class="card">
					<div class="search">
						<input id="searchTask" type="text" placeholder="Buscar em pendentes e concluídas..." />
					</div>
				</div>

				<div class="split">
					<div class="card">
						<h2>Pendentes (${pending.length})</h2>
						<div class="list" id="pendingList">
							${renderList(pending, false)}
						</div>
					</div>

					<div class="card">
						<h2>Concluídas (${completed.length})</h2>
						<div class="list" id="completedList">
							${renderList(completed, true)}
						</div>
					</div>
				</div>
			</div>
		</body>
		</html>
	`;
}

joplin.plugins.register({
	onStart: async function() {
		await joplin.settings.registerSection('willdoSection', {
			label: 'WillDo',
			iconName: 'fas fa-check',
		});

		await joplin.settings.registerSettings({
			[TASKS_KEY]: {
				value: '[]',
				type: SettingItemType.String,
				section: 'willdoSection',
				public: false,
				label: 'WillDo tasks storage',
			},
		});

		const panel = await joplin.views.panels.create('willdo.panel');

		const refreshPanel = async () => {
			const tasks = await reconcileWillDoTasks();
			await joplin.views.panels.setHtml(panel, renderTasks(tasks));
			await joplin.views.panels.addScript(panel, './webview.js');
		};

		await refreshPanel();
		await joplin.views.panels.show(panel);

		await joplin.views.panels.onMessage(panel, async (message: any) => {
			const tasks = await loadTasks();

			if (message?.type === 'addTask') {
				const title = String(message.title || '').trim();
				if (title) {
					tasks.unshift({
						id: uid(),
						title,
						completed: false,
						createdAt: new Date().toISOString(),
						recurrence: 'none',
					});
					await saveTasks(tasks);
					await refreshPanel();
				}
				return;
			}

			if (message?.type === 'toggleTask') {
				const id = String(message.id || '');
				const completed = !!message.completed;

				const updated: Task[] = [];

				for (const task of tasks) {
					if (task.id !== id) {
						updated.push(task);
						continue;
					}

					const recurrence = normalizeRecurrence(task.recurrence);

					if (completed && recurrence !== 'none' && task.dueAt) {
						const recurringTask: Task = {
							...task,
							completed: false,
							dueAt: nextRecurringDue(task.dueAt, recurrence),
							recurrence,
						};

						updated.push(await syncTodoMirror(recurringTask));
						continue;
					}

					updated.push(await syncTodoMirror({ ...task, completed }));
				}

				await saveTasks(updated);
				await refreshPanel();
				return;
			}

			if (message?.type === 'deleteTask') {
				const id = String(message.id || '');

				for (const task of tasks) {
					if (task.id === id) {
						await deleteTodoMirror(task);
					}
				}

				const updated = tasks.filter(task => task.id !== id);
				await saveTasks(updated);
				await refreshPanel();
				return;
			}

			if (message?.type === 'editTask') {
				const id = String(message.id || '');
				const title = String(message.title || '').trim();
				const dueAtRaw = String(message.dueAt || '').trim();
				const recurrence = normalizeRecurrence(String(message.recurrence || 'none'));

				const updated: Task[] = [];

				for (const task of tasks) {
					if (task.id !== id) {
						updated.push(task);
						continue;
					}

					const edited: Task = {
						...task,
						title: title || task.title,
						dueAt: dueAtRaw ? new Date(dueAtRaw).toISOString() : '',
						recurrence,
					};

					updated.push(await syncTodoMirror(edited));
				}

				await saveTasks(updated);
				await refreshPanel();
				return;
			}

			if (message?.type === 'linkCurrentNote') {
				const id = String(message.id || '');
				const note = await joplin.workspace.selectedNote();

				if (!note || !note.id) return;

				const updated: Task[] = [];
				for (const task of tasks) {
					if (task.id !== id) {
						updated.push(task);
						continue;
					}

					const linked: Task = {
						...task,
						noteId: note.id,
						noteTitle: note.title || '(Sem título)',
					};

					updated.push(await syncTodoMirror(linked));
				}

				await saveTasks(updated);
				await refreshPanel();
				return;
			}

			if (message?.type === 'clearNote') {
				const id = String(message.id || '');

				const updated: Task[] = [];
				for (const task of tasks) {
					if (task.id !== id) {
						updated.push(task);
						continue;
					}

					const cleared: Task = {
						...task,
						noteId: '',
						noteTitle: '',
					};

					updated.push(await syncTodoMirror(cleared));
				}

				await saveTasks(updated);
				await refreshPanel();
				return;
			}

			if (message?.type === 'openNote') {
				const id = String(message.id || '');
				const task = tasks.find(t => t.id === id);

				if (!task || !task.noteId) return;

				await joplin.commands.execute('openNote', task.noteId);
				return;
			}
		});

		await joplin.commands.register({
			name: 'willdoShowPanel',
			label: 'WillDo: Mostrar painel',
			execute: async () => {
				await joplin.views.panels.show(panel);
			},
		});

		await joplin.views.menuItems.create(
			'willdoShowPanelMenu',
			'willdoShowPanel',
			MenuItemLocation.Tools
		);

		console.info('WillDo plugin iniciado');
	},
});
