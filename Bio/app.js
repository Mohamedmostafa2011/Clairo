const firebaseConfig = {
  apiKey: "AIzaSyBOkZSP6ZMvdoZ8QAt0e8iRxzFa1-lRNnk",
  authDomain: "ig-bio-f9d8f.firebaseapp.com",
  projectId: "ig-bio-f9d8f",
  storageBucket: "ig-bio-f9d8f.firebasestorage.app",
  messagingSenderId: "630166010132",
  appId: "1:630166010132:web:72f335cf0f012b85bb6a01"
};

let currentEditElement = null; 
let userProgress = []; // Global progress store
let isGuestMode = false; // Guest mode flag
let allChapterDocIds = new Set(); // All doc IDs belonging to chapters section
let folderChildrenMap = {};       // { folderId: [docIds] } for completion checks

// ── DARK MODE ──
window.toggleTheme = function() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('themeIcon').className = isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    localStorage.setItem('igbio-theme', isDark ? 'light' : 'dark');
};
// Apply saved theme on load
(function() {
    const saved = localStorage.getItem('igbio-theme');
    if(saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();
document.addEventListener('DOMContentLoaded', function() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = document.getElementById('themeIcon');
    if(icon && isDark) icon.className = 'fa-solid fa-sun';
});

try {
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();
    let currentUser = null;
    let isAdmin = false;
    let isSignupMode = false;

    auth.onAuthStateChanged(async (user) => {
        // If we are in guest mode, don't trigger the auth login flow
        if (isGuestMode) return;

        if (user) {
            currentUser = user;
            const doc = await db.collection('users').doc(user.uid).get();
            if(doc.exists) {
                const data = doc.data();
                if(data.isAdmin === true) isAdmin = true;
                
                // PRE-LOAD PROGRESS
                userProgress = data.progress || [];
                
                updateUI(data);
                await loadAllContent(); // Now content loads with checked boxes
                updateProgressBar();
            }
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('main-app').style.display = 'block';
        } else {
            currentUser = null;
            isAdmin = false;
            document.getElementById('auth-screen').style.display = 'flex';
            document.getElementById('main-app').style.display = 'none';
        }
    });

    // GUEST LOGIN FUNCTION
    window.enterAsGuest = function() {
        isGuestMode = true;
        userProgress = []; // No saved progress
        isAdmin = false;
        currentUser = null;
        
        // Update UI for Guest
        updateUI({ username: "Guest", gender: "male", isAdmin: false });
        
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('main-app').style.display = 'block';
        
        loadAllContent(); // Load content without user specific progress
    }

    async function loadAllContent() {
        // Reset global trackers
        allChapterDocIds = new Set();
        folderChildrenMap = {};

        // Clear existing cards
        document.querySelectorAll('.chapter-card:not(.add-card)').forEach(card => card.remove());

        const snapshot = await db.collection('siteContent').get();
        const docs = [];
        snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
        docs.sort((a, b) => (a.orderIndex ?? 99999) - (b.orderIndex ?? 99999));

        // ── Pass 1: build folderChildrenMap and allChapterDocIds ──
        docs.forEach(item => {
            if(item.deleted || !item.sectionId) return;
            if(item.type === 'folder') {
                if(!folderChildrenMap[item.id]) folderChildrenMap[item.id] = [];
            } else if(item.folderId) {
                // Card inside a folder
                if(!folderChildrenMap[item.folderId]) folderChildrenMap[item.folderId] = [];
                folderChildrenMap[item.folderId].push(item.id);
                // Count toward chapters progress if folder belongs to chapters
                if(item.sectionId === 'chapters') allChapterDocIds.add(item.id);
            } else {
                // Standalone card
                if(item.sectionId === 'chapters') allChapterDocIds.add(item.id);
            }
        });

        // ── Pass 2: render cards ──
        docs.forEach(item => {
            if(item.deleted || !item.sectionId) return;
            if(item.sectionId === 'NEW_SECTION') {
                createNewSection(item.title, item.id);
            } else if(item.type === 'folder') {
                const childCount = (folderChildrenMap[item.id] || []).length;
                let gridId = (item.sectionId === 'chapters') ? 'grid' :
                                                          (item.sectionId === 'edu-games') ? 'gameGrid' : item.sectionId;
                createFolderCard(gridId, { ...item, childCount });
            } else if(item.folderId) {
                // Lives inside a folder — skip main page render
                return;
            } else {
                let gridId = (item.sectionId === 'chapters') ? 'grid' :
                                                          (item.sectionId === 'edu-games') ? 'gameGrid' : item.sectionId;
                createCard(gridId, item, item.id);
            }
        });

        if(isAdmin) enableAdminMode();

        // ── Pass 3: mark folders as completed if all children checked ──
        for(const [folderId, childIds] of Object.entries(folderChildrenMap)) {
            if(childIds.length > 0 && childIds.every(id => userProgress.includes(id))) {
                const card = document.querySelector(`.folder-card[data-doc-id="${folderId}"]`);
                if(card) card.classList.add('all-done');
            }
        }
    }

    function createCard(gridId, data, docId) {
        let grid = document.getElementById(gridId);
        if(!grid) return;
        
        // Handle duplicate IDs in dynamic sections
        if (!grid.classList.contains('chapter-grid') && grid.querySelector('.chapter-grid')) {
            grid = grid.querySelector('.chapter-grid');
        }

        const div = document.createElement('div');
        div.className = 'chapter-card';
        if(data.isHidden) div.classList.add('unavailable');
        
        div.onclick = function() { openFileInViewer(data.file); };
        div.setAttribute('data-doc-id', docId);
        div.setAttribute('data-file', data.file);
        div.setAttribute('data-section', data.sectionId || gridId);

        let iconHtml = (gridId === 'gameGrid') ? '<i class="fa-solid fa-gamepad"></i>' : '<i class="fa-solid fa-chevron-right"></i>';
        let subtitleHtml = data.subtitle ? `<div class="chapter-num">${data.subtitle}</div>` : '';

        // CHECKBOX LOGIC — add to grid cards AND folder cards (for all sections)
        let checkboxHtml = '';
        if(gridId === 'grid' || data.folderId) {
            const isChecked = userProgress.includes(docId) ? 'checked' : '';
            checkboxHtml = `<input type="checkbox" class="progress-check" id="chk-${docId}" ${isChecked} onclick="toggleProgress(event, '${docId}', '${data.sectionId || gridId}')">`;
        }

        div.innerHTML = `
            ${checkboxHtml}
            ${subtitleHtml}
            <div class="chapter-title" style="${!data.subtitle ? 'margin:auto' : ''}">${data.title}</div>
            <div class="chapter-icon">${iconHtml}</div>
        `;

        const addBtn = grid.querySelector('.add-card');
        
        // Safe insertion
        if (addBtn && addBtn.parentNode === grid) {
            grid.insertBefore(div, addBtn);
        } else {
            grid.appendChild(div);
        }
        
        if(isAdmin) injectAdminControls(div);
    }

    function enableAdminMode() {
        document.getElementById('adminBadge').style.display = 'inline-block';
        document.getElementById('addSectionBtn').style.display = 'block';
        document.querySelectorAll('.add-card').forEach(el => el.style.display = 'flex');
        document.querySelectorAll('.chapter-card:not(.add-card)').forEach(card => {
            if(card.classList.contains('folder-card')) injectFolderAdminControls(card);
            else injectAdminControls(card);
        });
        // Show select + create-folder buttons for all sections
        document.querySelectorAll('.select-mode-btn').forEach(btn => btn.style.display = 'inline-flex');
        document.querySelectorAll('.create-folder-btn').forEach(btn => btn.style.display = 'inline-flex');
        // Show select button in folder page header (only if folder page is open)
        const fpSelBtn = document.getElementById('folderPageSelectBtn');
        if(fpSelBtn && activeFolderData.id) fpSelBtn.style.display = 'inline-flex';
        
        const grids = ['grid', 'gameGrid'];
        document.querySelectorAll('.chapter-grid').forEach(g => { if(!grids.includes(g.id)) grids.push(g.id); });

        grids.forEach(gridId => {
            const el = document.getElementById(gridId);
            if(el) {
                Sortable.create(el, { 
                    handle: '.drag-handle', 
                    animation: 150,
                    draggable: ".chapter-card:not(.add-card)",
                    onEnd: async function(evt) {
                        const grid = evt.to;
                        const cards = grid.querySelectorAll('.chapter-card:not(.add-card)');
                        const batch = db.batch();
                        cards.forEach((card, index) => {
                            const id = card.getAttribute('data-doc-id');
                            if(id) batch.update(db.collection('siteContent').doc(id), { orderIndex: index });
                        });
                        await batch.commit();
                        console.log("Order Saved");
                    }
                });
            }
        });
        enableDragAndDrop('content-sections-wrapper', '.section-drag-handle');
    }

    function injectAdminControls(cardElement) {
        if(cardElement.querySelector('.admin-controls')) return;
        const controls = document.createElement('div');
        controls.className = 'admin-controls';
        const isHidden = cardElement.classList.contains('unavailable');
        controls.innerHTML = `
            <div class="control-btn drag-handle"><i class="fa-solid fa-bars"></i></div>
            <div class="control-btn" onclick="openEditModal(this)"><i class="fa-solid fa-gear"></i></div>
            <div class="control-btn" onclick="toggleVisibility(event, this)"><i class="fa-regular ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i></div>
        `;
        controls.onclick = (e) => e.stopPropagation();
        cardElement.appendChild(controls);
        cardElement.classList.add('admin-view');
        controls.style.display = 'flex';
    }

    window.toggleProgress = async function(e, id, sectionId) {
        e.stopPropagation(); 
        
        // GUEST CHECK INTERCEPTION
        if (isGuestMode) {
            e.preventDefault();
            document.getElementById('guestLimitModal').style.display = 'flex';
            return;
        }

        const box = document.getElementById('chk-' + id) || document.getElementById(id);
        const action = box.checked ? 'arrayUnion' : 'arrayRemove';
        
        if (currentUser) {
            await db.collection('users').doc(currentUser.uid).update({ progress: firebase.firestore.FieldValue[action](id) });
        }
        
        if(box.checked) userProgress.push(id);
        else userProgress = userProgress.filter(item => item !== id);
        updateProgressBar();

        // Check folder completion badge if inside a folder page
        if(activeFolderData.id) checkFolderCompletion(activeFolderData.id);
    }

    window.updateProgressBar = function() {
        // Count ALL docs that belong to chapters section (sectionId='chapters')
        // including cards inside folders — tracked in allChapterDocIds
        const total = allChapterDocIds.size || 1;
        const checked = [...allChapterDocIds].filter(id => userProgress.includes(id)).length;
        const pct = Math.round((checked / total) * 100);
        document.getElementById('progressFill').style.width = pct + "%";
        document.getElementById('progressText').innerText = pct + "%";
    }

    window.openAdminModal = function(s) { 
        document.getElementById('adminAddModal').style.display = 'flex'; 
        document.getElementById('adminTargetSection').value = s; 
        document.getElementById('adminTitle').value = "";
        document.getElementById('adminNum').value = "";
        document.getElementById('adminFile').value = "";
    }

    window.saveAdminItem = async function() {
        const section = document.getElementById('adminTargetSection').value;
        const title = document.getElementById('adminTitle').value;
        const num = document.getElementById('adminNum').value;
        const file = document.getElementById('adminFile').value;
        if(!title || !file) { alert("Required"); return; }

        // Check if we're adding inside a folder
        const isFolderTarget = section.startsWith('__folder__:');
        const folderId = isFolderTarget ? section.replace('__folder__:', '') : null;
        const realSection = folderId ? activeFolderData.sectionId || 'chapters' : section;

        const newItem = {
            sectionId: realSection, title, subtitle: num, file,
            orderIndex: 9999, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            ...(folderId ? { folderId } : {})
        };
        const docRef = await db.collection('siteContent').add(newItem);
        document.getElementById('adminAddModal').style.display = 'none';

        // Track in allChapterDocIds if relevant
        if(realSection === 'chapters') allChapterDocIds.add(docRef.id);

        if(folderId) {
            // Track in folderChildrenMap
            if(!folderChildrenMap[folderId]) folderChildrenMap[folderId] = [];
            folderChildrenMap[folderId].push(docRef.id);

            // Add card directly into folder page grid
            const folderGrid = document.getElementById('folderPageGrid');
            const div = document.createElement('div');
            div.className = 'chapter-card';
            div.setAttribute('data-doc-id', docRef.id);
            div.setAttribute('data-file', file);
            div.setAttribute('data-section', realSection);
            div.onclick = function() { openFileInViewer(file); };
            const isChecked = userProgress.includes(docRef.id) ? 'checked' : '';
            let subtitleHtml = num ? `<div class="chapter-num">${num}</div>` : '';
            div.innerHTML = `
                <input type="checkbox" class="progress-check" id="chk-${docRef.id}" ${isChecked}
                    onclick="toggleProgress(event, '${docRef.id}', '${realSection}')">
                ${subtitleHtml}
                <div class="chapter-title" style="${!num ? 'margin:auto' : ''}">${title}</div>
                <div class="chapter-icon"><i class="fa-solid fa-chevron-right"></i></div>
            `;
            injectAdminControls(div);
            const addBtn = document.getElementById('folderAddCardBtn');
            if(addBtn) folderGrid.insertBefore(div, addBtn);
            else folderGrid.appendChild(div);
            // Update item count
            const countEl = document.getElementById(`fc-${folderId}`);
            if(countEl) {
                countEl.textContent = `${folderChildrenMap[folderId].length} items`;
            }
            updateProgressBar();
        } else {
            let gridId = (realSection === 'chapters') ? 'grid' :(realSection === 'edu-games') ? 'gameGrid' : realSection;
            createCard(gridId, { ...newItem, sectionId: realSection }, docRef.id);
            updateProgressBar();
        }
    };
    window.openEditModal = function(btn) { 
        const card = btn.closest('.chapter-card'); 
        currentEditElement = card; 
        document.getElementById('editItemId').value = card.getAttribute('data-doc-id');
        document.getElementById('editTitle').value = card.querySelector('.chapter-title').innerText;
        document.getElementById('editSubtitle').value = card.querySelector('.chapter-num') ? card.querySelector('.chapter-num').innerText : "";
        document.getElementById('editFile').value = card.getAttribute('data-file') || "";
        document.getElementById('adminEditModal').style.display = 'flex'; 
    }

    window.saveEditItem = async function() {
        let id = document.getElementById('editItemId').value;
        const title = document.getElementById('editTitle').value;
        const sub = document.getElementById('editSubtitle').value;
        const file = document.getElementById('editFile').value;
        
        await db.collection('siteContent').doc(id).update({ title, subtitle: sub, file });
        
        const card = currentEditElement;
        card.querySelector('.chapter-title').innerText = title;
        if(card.querySelector('.chapter-num')) card.querySelector('.chapter-num').innerText = sub;
        else if(sub) card.innerHTML = `<div class="chapter-num">${sub}</div>` + card.innerHTML;
        card.setAttribute('data-file', file);
        card.onclick = function() { openFileInViewer(file); };
        
        document.getElementById('adminEditModal').style.display = 'none';
    }

    window.deleteItem = async function() {
        if(!confirm("Delete?")) return;
        let id = document.getElementById('editItemId').value;
        await db.collection('siteContent').doc(id).update({ deleted: true });
        currentEditElement.remove();
        document.getElementById('adminEditModal').style.display = 'none';
    }

    window.toggleVisibility = async function(e, btn) {
        e.stopPropagation();
        const card = btn.closest('.chapter-card');
        const isHidden = !card.classList.contains('unavailable');
        card.classList.toggle('unavailable');
        btn.innerHTML = `<i class="fa-regular ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        await db.collection('siteContent').doc(card.getAttribute('data-doc-id')).update({ isHidden });
    }

    window.toggleAuthMode = function() { isSignupMode = !isSignupMode; document.getElementById('authTitle').innerText = isSignupMode ? "Create Account" : "Sign In"; document.getElementById('authActionBtn').innerText = isSignupMode ? "Sign Up" : "Login"; document.getElementById('signupExtras').style.display = isSignupMode ? "block" : "none"; }
    window.handleAuthAction = async function() {
        const email = document.getElementById('email').value; const pass = document.getElementById('password').value;
        try {
            if(isSignupMode) {
                const cred = await auth.createUserWithEmailAndPassword(email, pass);
                const username = document.getElementById('username').value || "Student";
                const gender = document.querySelector('input[name="gender"]:checked').value;
                await db.collection('users').doc(cred.user.uid).set({ username, gender, progress: [], isAdmin: false });
            } else await auth.signInWithEmailAndPassword(email, pass);
        } catch (e) { alert(e.message); }
    }
    window.logout = function() { auth.signOut(); window.location.reload(); }
    window.updateUI = function(data) {
        const img = (data.gender === 'female') ? "https://cdn-icons-png.flaticon.com/512/4128/4128253.png" : "https://cdn-icons-png.flaticon.com/512/4128/4128176.png";
        document.getElementById('topRightAvatar').src = img;
        document.getElementById('profileModalAvatar').src = img;
        document.getElementById('welcomeMsg').innerText = `Welcome, ${data.username}!`;
        document.getElementById('profileUsername').innerText = data.username;
    }
    window.openProfileSettings = function() { document.getElementById('profileModal').style.display = 'flex'; }
    window.enableDragAndDrop = function(elId, handle) { const el = document.getElementById(elId); if(el) Sortable.create(el, { handle: handle, animation: 150 }); }
    
    // UPDATED createNewSection FUNCTION
    function createNewSection(title, docId) {
        const safeId = title.replace(/\s+/g, '-').toLowerCase();
        
        // If section already exists in DOM, don't recreate
        if(document.getElementById(safeId)) return;

        // Create Nav Link
        document.getElementById('nav-links').innerHTML += `<li id="nav-li-${safeId}"><a href="#${safeId}"><i class="fa-solid fa-book"></i> ${title}</a></li>`;
        
        // Create Delete Button HTML (Only if Admin)
        let deleteHtml = '';
        if(isAdmin && docId) {
            deleteHtml = `<i class="fa-solid fa-trash" 
                onclick="deleteSection('${docId}', '${safeId}')" 
                style="color:var(--danger); cursor:pointer; font-size:1.2rem; margin-left:15px;" 
                title="Delete Section"></i>`;
        }

        const w = document.getElementById('content-sections-wrapper');
        const s = document.createElement('section'); 
        s.className = 'chapters-section'; 
        s.id = `section-wrapper-${safeId}`; // Wrapper ID

        s.innerHTML = `
            <div class="section-header">
                <i class="fa-solid fa-bars section-drag-handle"></i>
                <div style="display:flex; align-items:center; justify-content:center;">
                    <h2>${title}</h2>
                    ${deleteHtml}
                </div>
            </div>
            <div class="search-row">
                <div class="search-container" style="margin:0; flex:1;">
                    <i class="fa-solid fa-magnifying-glass search-icon"></i>
                    <input type="text" class="search-bar" placeholder="Search..." onkeyup="filterGrid('${safeId}', this.value)">
                </div>
                <button class="select-mode-btn" data-grid="${safeId}" onclick="toggleSelectionMode('${safeId}')"
                    style="${isAdmin ? 'display:inline-flex' : 'display:none'}">
                    <i class="fa-regular fa-square-check"></i> Select
                </button>
                <button class="create-folder-btn" data-grid="${safeId}" onclick="openCreateFolderDirect('${safeId}')"
                    style="${isAdmin ? 'display:inline-flex' : 'display:none'}">
                    <i class="fa-solid fa-folder-plus"></i> New Folder
                </button>
            </div>
            <div class="chapter-grid" id="${safeId}">
                <div class="chapter-card add-card" onclick="openAdminModal('${safeId}')">
                    <i class="fa-solid fa-plus"></i>
                </div>
            </div>`;
        w.appendChild(s);
    }

    // NEW deleteSection FUNCTION
    window.deleteSection = async function(docId, safeId) {
        if(!confirm("Are you sure you want to delete this ENTIRE section? content inside will be hidden.")) return;
        
        try {
            // 1. Mark the section definition as deleted in Firebase
            await db.collection('siteContent').doc(docId).update({ deleted: true });

            // 2. Remove from UI immediately
            const sectionEl = document.getElementById(`section-wrapper-${safeId}`);
            if(sectionEl) sectionEl.remove();

            // 3. Remove from Navigation
            const navEl = document.getElementById(`nav-li-${safeId}`);
            if(navEl) navEl.remove();

            console.log("Section deleted successfully");
        } catch(e) {
            alert("Error deleting section: " + e.message);
        }
    }

    window.filterGrid = function(gid, val) {
        const v = val.toUpperCase();
        document.querySelectorAll('#'+gid+' .chapter-card:not(.add-card)').forEach(c => {
            c.style.display = c.innerText.toUpperCase().includes(v) ? 'flex' : 'none';
        });
    }

    // ==================== SELECTION MODE ====================
    // context: 'homepage' | 'folder'
    let selState = { active: false, gridId: null, selected: new Set(), context: 'homepage' };
    let activeFolderData = { id: null, name: null, sectionId: null };

    window.toggleSelectionMode = function(gridId) {
        if(selState.active && selState.gridId === gridId) {
            exitSelectionMode();
        } else {
            if(selState.active) exitSelectionMode();
            enterSelectionMode(gridId, 'homepage');
        }
    };

    window.toggleFolderSelectionMode = function() {
        if(selState.active && selState.context === 'folder') {
            exitSelectionMode();
        } else {
            if(selState.active) exitSelectionMode();
            enterSelectionMode('folderPageGrid', 'folder');
        }
    };

    function enterSelectionMode(gridId, context) {
        selState = { active: true, gridId, selected: new Set(), context };
        const grid = document.getElementById(gridId);
        if(!grid) return;

        // Include ALL cards (including folder-cards) in selection
        grid.querySelectorAll('.chapter-card:not(.add-card)').forEach(card => {
            card.classList.add('selectable');
            if(!card.querySelector('.select-overlay')) {
                const ov = document.createElement('div');
                ov.className = 'select-overlay';
                ov.innerHTML = '<span class="select-overlay-check">✓</span>';
                card.insertBefore(ov, card.firstChild);
            }
            card._origClick = card.onclick;
            card.onclick = function(e) { e.stopPropagation(); toggleCardSel(card); };
        });

        // Show/hide context-specific toolbar buttons
        const folderBtn  = document.getElementById('toolbarFolderBtn');
        const removeBtn  = document.getElementById('toolbarRemoveBtn');
        if(context === 'folder') {
            if(folderBtn) folderBtn.style.display = 'none';
            if(removeBtn) removeBtn.style.display = 'flex';
            // Update folder page select btn style
            const fpBtn = document.getElementById('folderPageSelectBtn');
            if(fpBtn) { fpBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel'; fpBtn.classList.add('active'); }
        } else {
            if(folderBtn) folderBtn.style.display = 'flex';
            if(removeBtn) removeBtn.style.display = 'none';
            const btn = document.querySelector(`.select-mode-btn[data-grid="${gridId}"]`);
            if(btn) { btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel'; btn.classList.add('active'); }
        }

        document.getElementById('selectionToolbar').classList.add('visible');
        updateSelCount();
    }

    window.exitSelectionMode = function() {
        if(!selState.active) return;
        const grid = document.getElementById(selState.gridId);
        if(grid) {
            grid.querySelectorAll('.chapter-card.selectable').forEach(card => {
                card.classList.remove('selectable','selected');
                if(card._origClick !== undefined) { card.onclick = card._origClick; delete card._origClick; }
            });
        }
        const wasFolder = selState.context === 'folder';
        selState = { active: false, gridId: null, selected: new Set(), context: 'homepage' };
        document.getElementById('selectionToolbar').classList.remove('visible');
        document.querySelectorAll('.select-mode-btn').forEach(btn => {
            btn.innerHTML = '<i class="fa-regular fa-square-check"></i> Select';
            btn.classList.remove('active');
        });
        if(wasFolder) {
            const fpBtn = document.getElementById('folderPageSelectBtn');
            if(fpBtn) { fpBtn.innerHTML = '<i class="fa-regular fa-square-check"></i> Select'; fpBtn.classList.remove('active'); }
        }
    };

    function toggleCardSel(card) {
        if(selState.selected.has(card)) {
            selState.selected.delete(card); card.classList.remove('selected');
        } else {
            selState.selected.add(card); card.classList.add('selected');
        }
        updateSelCount();
    }

    function updateSelCount() {
        document.getElementById('selCount').textContent = `${selState.selected.size} selected`;
    }

    window.deleteSelectedCards = async function() {
        if(selState.selected.size === 0) { alert("Select at least one card first!"); return; }
        if(!confirm(`Delete ${selState.selected.size} item(s)? This cannot be undone.`)) return;
        const batch = db.batch();
        for(const card of selState.selected) {
            const docId = card.getAttribute('data-doc-id');
            if(!docId) continue;
            batch.update(db.collection('siteContent').doc(docId), { deleted: true });
            // If it's a folder, delete all its children too
            if(card.classList.contains('folder-card')) {
                const children = folderChildrenMap[docId] || [];
                children.forEach(cid => {
                    batch.update(db.collection('siteContent').doc(cid), { deleted: true });
                    allChapterDocIds.delete(cid);
                });
                delete folderChildrenMap[docId];
            }
            allChapterDocIds.delete(docId);
            card.remove();
        }
        await batch.commit();
        exitSelectionMode();
        updateProgressBar();
    };

    window.promptCreateFolder = function() {
        if(selState.selected.size === 0) { alert("Select at least one card first!"); return; }
        // Can only create folder from homepage cards (not inside a folder)
        if(selState.context === 'folder') { alert("Cannot create a folder inside a folder."); return; }
        document.getElementById('folderNameInput').value = '';
        document.getElementById('folderNameModal').style.display = 'flex';
        setTimeout(() => document.getElementById('folderNameInput').focus(), 100);
    };

    // Create empty folder directly (no pre-selection needed)
    window.openCreateFolderDirect = function(gridId) {
        document.getElementById('folderNameInput').value = '';
        document.getElementById('folderNameModal').style.display = 'flex';
        // Store the target gridId for use in confirmCreateFolder
        document.getElementById('folderNameModal').setAttribute('data-target-grid', gridId);
        setTimeout(() => document.getElementById('folderNameInput').focus(), 100);
    };

    window.confirmCreateFolder = async function() {
        const name = document.getElementById('folderNameInput').value.trim();
        if(!name) { document.getElementById('folderNameInput').focus(); return; }
        document.getElementById('folderNameModal').style.display = 'none';

        // If triggered from toolbar (selection mode), use selState.gridId
        // If triggered from New Folder button directly, use the modal's data-target-grid
        let gridId;
        if(selState.active && selState.context === 'homepage') {
            gridId = selState.gridId;
        } else {
            gridId = document.getElementById('folderNameModal').getAttribute('data-target-grid') || 'grid';
        }
        document.getElementById('folderNameModal').removeAttribute('data-target-grid');

        const sectionId = gridId === 'grid' ? 'chapters' :
                           gridId === 'gameGrid' ? 'edu-games' : gridId;

        // Save folder to Firebase
        const folderRef = await db.collection('siteContent').add({
            sectionId, type: 'folder', title: name,
            orderIndex: 9999,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        const folderId = folderRef.id;
        folderChildrenMap[folderId] = [];

        if(selState.active && selState.selected.size > 0 && selState.context === 'homepage') {
            // Move selected cards into new folder
            const batch = db.batch();
            const movedCards = [];
            selState.selected.forEach(card => {
                const docId = card.getAttribute('data-doc-id');
                if(docId) {
                    batch.update(db.collection('siteContent').doc(docId), { folderId });
                    movedCards.push({ el: card, docId });
                    folderChildrenMap[folderId].push(docId);
                }
            });
            await batch.commit();
            movedCards.forEach(({ el }) => el.remove());
            createFolderCard(gridId, { id: folderId, title: name, type: 'folder', sectionId, childCount: movedCards.length });
            exitSelectionMode();
        } else {
            // Empty folder — just show it
            createFolderCard(gridId, { id: folderId, title: name, type: 'folder', sectionId, childCount: 0 });
        }
    };

    // ==================== FOLDER CARD ====================
    function createFolderCard(gridId, folderData) {
        let grid = document.getElementById(gridId);
        if(!grid) return;
        if(!grid.classList.contains('chapter-grid') && grid.querySelector('.chapter-grid')) {
            grid = grid.querySelector('.chapter-grid');
        }

        const div = document.createElement('div');
        div.className = 'chapter-card folder-card';
        div.setAttribute('data-doc-id', folderData.id);
        div.setAttribute('data-type', 'folder');
        div.setAttribute('data-folder-name', folderData.title);
        div.setAttribute('data-folder-section', folderData.sectionId || gridId);
        div.onclick = function() { openFolderPage(folderData.id, folderData.title); };
        if(folderData.isHidden) div.classList.add('unavailable');

        div.innerHTML = `
            <div class="folder-done-badge" title="All topics covered!">✓</div>
            <div class="folder-icon-wrap"><i class="fa-solid fa-folder-open"></i></div>
            <div class="folder-name">${folderData.title}</div>
            <div class="folder-count" id="fc-${folderData.id}">${folderData.childCount || 0} items</div>
            <div class="folder-arrow"><i class="fa-solid fa-chevron-right"></i></div>
        `;

        if(isAdmin) injectFolderAdminControls(div);

        const addBtn = grid.querySelector('.add-card');
        if(addBtn && addBtn.parentNode === grid) grid.insertBefore(div, addBtn);
        else grid.appendChild(div);
    }

    function injectFolderAdminControls(cardEl) {
        if(cardEl.querySelector('.admin-controls')) return;
        const controls = document.createElement('div');
        controls.className = 'admin-controls';
        const isHidden = cardEl.classList.contains('unavailable');
        controls.innerHTML = `
            <div class="control-btn drag-handle"><i class="fa-solid fa-bars"></i></div>
            <div class="control-btn" onclick="openRenameFolderFromCard(this)" title="Rename"><i class="fa-solid fa-pen"></i></div>
            <div class="control-btn" onclick="toggleFolderVisibility(event, this)" title="${isHidden ? 'Show' : 'Hide'}">
                <i class="fa-regular ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>
            </div>
            <div class="control-btn" onclick="deleteFolderFromCard(event, this)" title="Delete Folder"
                style="color:var(--danger);">
                <i class="fa-solid fa-trash"></i>
            </div>
        `;
        controls.onclick = (e) => e.stopPropagation();
        cardEl.appendChild(controls);
        cardEl.classList.add('admin-view');
        controls.style.display = 'flex';
    }

    window.toggleFolderVisibility = async function(e, btn) {
        e.stopPropagation();
        const card = btn.closest('.folder-card');
        const isHidden = !card.classList.contains('unavailable');
        card.classList.toggle('unavailable');
        btn.innerHTML = `<i class="fa-regular ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        btn.title = isHidden ? 'Show' : 'Hide';
        await db.collection('siteContent').doc(card.getAttribute('data-doc-id')).update({ isHidden });
    };

    window.openRenameFolderFromCard = function(btn) {
        const card = btn.closest('.folder-card');
        document.getElementById('renameFolderId').value = card.getAttribute('data-doc-id');
        document.getElementById('renameFolderInput').value = card.getAttribute('data-folder-name');
        document.getElementById('renameFolderModal').style.display = 'flex';
        setTimeout(() => document.getElementById('renameFolderInput').select(), 100);
    };

    window.openRenameFolderModal = function() {
        document.getElementById('renameFolderId').value = activeFolderData.id;
        document.getElementById('renameFolderInput').value = activeFolderData.name;
        document.getElementById('renameFolderModal').style.display = 'flex';
        setTimeout(() => document.getElementById('renameFolderInput').select(), 100);
    };

    window.confirmRenameFolder = async function() {
        const folderId = document.getElementById('renameFolderId').value;
        const newName = document.getElementById('renameFolderInput').value.trim();
        if(!newName) return;

        await db.collection('siteContent').doc(folderId).update({ title: newName });

        // Update home page folder card
        const homeCard = document.querySelector(`.folder-card[data-doc-id="${folderId}"]`);
        if(homeCard) {
            homeCard.querySelector('.folder-name').textContent = newName;
            homeCard.setAttribute('data-folder-name', newName);
        }
        // Update folder page title if open
        if(activeFolderData.id === folderId) {
            activeFolderData.name = newName;
            document.getElementById('folderPageTitle').textContent = newName;
        }
        document.getElementById('renameFolderModal').style.display = 'none';
    };

    // ==================== FOLDER PAGE ====================
    window.openFolderPage = async function(folderId, folderName) {
        const folderCard = document.querySelector(`.folder-card[data-doc-id="${folderId}"]`);
        const sectionId = folderCard ? folderCard.getAttribute('data-folder-section') : 'chapters';
        activeFolderData = { id: folderId, name: folderName, sectionId };
        document.getElementById('folderPageTitle').textContent = folderName;
        document.getElementById('folderPageRenameBtn').style.display = isAdmin ? 'inline-flex' : 'none';
        document.getElementById('folderPageSelectBtn').style.display = isAdmin ? 'inline-flex' : 'none';
        if(isAdmin) document.getElementById('folderAddCardBtn').style.display = 'flex';
        else document.getElementById('folderAddCardBtn').style.display = 'none';

        const folderGrid = document.getElementById('folderPageGrid');
        // Clear all except the add-card button
        Array.from(folderGrid.children).forEach(c => { if(!c.classList.contains('add-card')) c.remove(); });
        // Show loading
        const loader = document.createElement('div');
        loader.id = 'folderLoader';
        loader.style.cssText = 'text-align:center; padding:50px; color:var(--text-light); grid-column:1/-1;';
        loader.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:2rem;"></i>';
        folderGrid.insertBefore(loader, document.getElementById('folderAddCardBtn'));
        document.getElementById('folderPage').classList.add('open');
        history.pushState({ igbio: 'folder' }, '');

        const snapshot = await db.collection('siteContent')
            .where('folderId', '==', folderId).get();

        const items = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            if(!d.deleted) items.push({ id: doc.id, ...d });
        });
        items.sort((a, b) => (a.orderIndex ?? 99999) - (b.orderIndex ?? 99999));

        const loaderEl = document.getElementById('folderLoader');
        if(loaderEl) loaderEl.remove();

        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'chapter-card';
            if(item.isHidden) div.classList.add('unavailable');
            div.setAttribute('data-doc-id', item.id);
            div.setAttribute('data-file', item.file || '');
            div.setAttribute('data-section', item.sectionId || '');
            div.onclick = function() { if(item.file) openFileInViewer(item.file); };

            const isChecked = userProgress.includes(item.id) ? 'checked' : '';
            let subtitleHtml = item.subtitle ? `<div class="chapter-num">${item.subtitle}</div>` : '';

            div.innerHTML = `
                <input type="checkbox" class="progress-check" id="chk-${item.id}" ${isChecked}
                    onclick="toggleProgress(event, '${item.id}', '${item.sectionId || ''}')">
                ${subtitleHtml}
                <div class="chapter-title" style="${!item.subtitle ? 'margin:auto' : ''}">${item.title}</div>
                <div class="chapter-icon"><i class="fa-solid fa-chevron-right"></i></div>
            `;
            if(isAdmin) injectAdminControls(div);
            folderGrid.insertBefore(div, document.getElementById('folderAddCardBtn'));
        });

        // Update item count on folder card
        const countEl = document.getElementById(`fc-${folderId}`);
        if(countEl) countEl.textContent = `${items.length} items`;

        // Check completion badge
        checkFolderCompletion(folderId);

        // Drag-and-drop inside folder
        if(isAdmin) {
            Sortable.create(folderGrid, {
                handle: '.drag-handle', animation: 150,
                draggable: '.chapter-card:not(.add-card)',
                onEnd: async function() {
                    const cards = folderGrid.querySelectorAll('.chapter-card:not(.add-card)');
                    const batch = db.batch();
                    cards.forEach((card, idx) => {
                        const id = card.getAttribute('data-doc-id');
                        if(id) batch.update(db.collection('siteContent').doc(id), { orderIndex: idx });
                    });
                    await batch.commit();
                }
            });
        }
    };

    // Open admin add modal but pre-target the current folder
    window.openAdminModalInFolder = function() {
        const fId = activeFolderData.id;
        if(!fId) return;
        document.getElementById('adminAddModal').style.display = 'flex';
        document.getElementById('adminTargetSection').value = '__folder__:' + fId;
        document.getElementById('adminTitle').value = '';
        document.getElementById('adminNum').value = '';
        document.getElementById('adminFile').value = '';
    };

    // ── FOLDER COMPLETION BADGE ──
    function checkFolderCompletion(folderId) {
        const grid = document.getElementById('folderPageGrid');
        if(!grid || activeFolderData.id !== folderId) return;
        const checks = grid.querySelectorAll('.progress-check');
        if(checks.length === 0) return;
        const allDone = Array.from(checks).every(cb => cb.checked);
        const folderCard = document.querySelector(`.folder-card[data-doc-id="${folderId}"]`);
        if(folderCard) {
            folderCard.classList.toggle('all-done', allDone);
        }
    }


    // ==================== MOVE TO FOLDER ====================
    window.openMoveModal = function() {
        if(selState.selected.size === 0) { alert("Select at least one item first!"); return; }
        const scroll = document.getElementById('moveDestScroll');
        scroll.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-light);"><i class="fa-solid fa-spinner fa-spin"></i></div>';
        document.getElementById('moveToFolderModal').style.display = 'flex';

        // Build destination list from DOM sections + folders
        let html = '';
        // Sections
        const sectionDefs = [
            { gridId: 'grid', label: 'Course Content (Homepage)' },
            { gridId: 'gameGrid', label: 'Edu-Games (Homepage)' },
        ];
        // Dynamic sections
        document.querySelectorAll('#content-sections-wrapper section.chapters-section').forEach(sec => {
            const grid = sec.querySelector('.chapter-grid');
            if(grid && !['grid','gameGrid'].includes(grid.id)) {
                const h2 = sec.querySelector('h2');
                sectionDefs.push({ gridId: grid.id, label: `${h2 ? h2.textContent : grid.id} (Homepage)` });
            }
        });

        html += '<div class="move-section-label">Sections (no folder)</div>';
        sectionDefs.forEach(sd => {
            html += `<div class="move-dest-item" onclick="executeMove(null,'${sd.gridId}')">
                <i class="fa-solid fa-layer-group"></i> ${sd.label}
            </div>`;
        });

        // Folders (read from DOM folder-cards)
        html += '<div class="move-section-label">Folders</div>';
        let folderCount = 0;
        document.querySelectorAll('.folder-card[data-doc-id]').forEach(fc => {
            const fid = fc.getAttribute('data-doc-id');
            const fname = fc.getAttribute('data-folder-name') || 'Folder';
            const fSec = fc.getAttribute('data-folder-section') || 'chapters';
            const fGrid = fSec === 'chapters' ? 'grid' :fSec === 'edu-games' ? 'gameGrid' : fSec;
            html += `<div class="move-dest-item folder-dest" onclick="executeMove('${fid}','${fGrid}','${fSec}')">
                <i class="fa-solid fa-folder"></i> ${fname}
            </div>`;
            folderCount++;
        });
        if(folderCount === 0) html += '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:12px;">No folders yet</p>';

        scroll.innerHTML = html;
    };

    window.executeMove = async function(targetFolderId, targetGridId, targetSectionId) {
        document.getElementById('moveToFolderModal').style.display = 'none';
        if(selState.selected.size === 0) return;

        const realSectionId = targetSectionId || (
            targetGridId === 'grid' ? 'chapters' :
            targetGridId === 'gameGrid' ? 'edu-games' : targetGridId
        );

        const batch = db.batch();
        const toProcess = [...selState.selected];

        for(const card of toProcess) {
            const docId = card.getAttribute('data-doc-id');
            if(!docId) continue;
            const isFolder = card.classList.contains('folder-card');

            const updateData = { sectionId: realSectionId };
            if(targetFolderId) {
                updateData.folderId = targetFolderId;
            } else {
                updateData.folderId = firebase.firestore.FieldValue.delete();
            }
            batch.update(db.collection('siteContent').doc(docId), updateData);

            // Update allChapterDocIds
            if(!isFolder) {
                if(realSectionId === 'chapters') allChapterDocIds.add(docId);
                else allChapterDocIds.delete(docId);
            }

            // Update folderChildrenMap: remove from old folder
            for(const [fid, kids] of Object.entries(folderChildrenMap)) {
                const idx = kids.indexOf(docId);
                if(idx !== -1) { kids.splice(idx, 1); break; }
            }
            // Add to new folder
            if(targetFolderId) {
                if(!folderChildrenMap[targetFolderId]) folderChildrenMap[targetFolderId] = [];
                if(!isFolder) folderChildrenMap[targetFolderId].push(docId);
            }

            card.remove();
        }
        await batch.commit();

        // If moving into a folder page currently open, re-render it
        if(targetFolderId && activeFolderData.id === targetFolderId) {
            await openFolderPage(targetFolderId, activeFolderData.name);
        } else if(targetFolderId) {
            // Just update count badge on folder card
            const countEl = document.getElementById(`fc-${targetFolderId}`);
            if(countEl && folderChildrenMap[targetFolderId]) {
                countEl.textContent = `${folderChildrenMap[targetFolderId].length} items`;
            }
        } else {
            // Moving to homepage — re-render moved items
            for(const card of toProcess) {
                const docId = card.getAttribute('data-doc-id');
                if(!docId) continue;
                const snap = await db.collection('siteContent').doc(docId).get();
                if(snap.exists) {
                    const data = snap.data();
                    if(data.type === 'folder') {
                        createFolderCard(targetGridId, { ...data, id: docId, childCount: (folderChildrenMap[docId]||[]).length });
                    } else {
                        createCard(targetGridId, { ...data }, docId);
                    }
                }
            }
        }

        exitSelectionMode();
        updateProgressBar();
    };

    // ── Remove selected cards from folder (move to homepage) ──
    window.removeSelectedFromFolder = function() {
        if(selState.selected.size === 0 || selState.context !== 'folder') return;
        const sectionId = activeFolderData.sectionId || 'chapters';
        const gridId = sectionId === 'chapters' ? 'grid' :
                       sectionId === 'edu-games' ? 'gameGrid' : sectionId;
        executeMove(null, gridId, sectionId);
    };

    // ── Delete a folder (move its contents to homepage) ──
    window.deleteFolderFromCard = async function(e, btn) {
        e.stopPropagation();
        const card = btn.closest('.folder-card');
        const folderId = card.getAttribute('data-doc-id');
        const folderName = card.getAttribute('data-folder-name') || 'this folder';
        const sectionId = card.getAttribute('data-folder-section') || 'chapters';
        const gridId = sectionId === 'chapters' ? 'grid' :
                       sectionId === 'edu-games' ? 'gameGrid' : sectionId;

        if(!confirm(`Delete "${folderName}"? All cards inside will be moved back to the homepage section.`)) return;

        // Get all children from Firebase
        const snap = await db.collection('siteContent').where('folderId','==',folderId).get();
        const batch = db.batch();
        batch.update(db.collection('siteContent').doc(folderId), { deleted: true });
        snap.forEach(doc => {
            batch.update(db.collection('siteContent').doc(doc.id), {
                folderId: firebase.firestore.FieldValue.delete()
            });
        });
        await batch.commit();

        // Render children on homepage
        snap.forEach(doc => {
            const data = doc.data();
            if(!data.deleted) createCard(gridId, { ...data, folderId: undefined }, doc.id);
        });

        // Update tracking
        delete folderChildrenMap[folderId];
        card.remove();
        updateProgressBar();
    };

    window.closeFolderPage = function() {
        document.getElementById('folderPage').classList.remove('open');
        if(selState.active && selState.context === 'folder') exitSelectionMode();
    };

} catch (e) { console.error(e); }

// ── IFRAME FILE VIEWER ──────────────────────────────────────────────
window.openFileInViewer = function(filePath) {
    if (!filePath) return;
    const overlay = document.getElementById('fileViewerOverlay');
    const iframe  = document.getElementById('fileViewerIframe');
    iframe.src = filePath;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    // Push a history state so the browser back button triggers close
    history.pushState({ igbio: 'viewer' }, '');
};

window.closeFileViewer = function() {
    const overlay = document.getElementById('fileViewerOverlay');
    const iframe  = document.getElementById('fileViewerIframe');
    overlay.classList.remove('open');
    iframe.src = '';
    document.body.style.overflow = '';
};

// ── BACK BUTTON HANDLER ─────────────────────────────────────────────
window.addEventListener('popstate', function(e) {
    const overlay = document.getElementById('fileViewerOverlay');

    // Priority 1: close viewer if open
    if (overlay && overlay.classList.contains('open')) {
        closeFileViewer();
        return;
    }

    // Priority 2: close folder page if open
    const folderPage = document.getElementById('folderPage');
    if (folderPage && folderPage.classList.contains('open')) {
        closeFolderPage();
        return;
    }
});

// Push a history state when a folder is opened so back button works
const _origFolderPageOpen = document.getElementById('folderPage');
// Wrap closeFolderPage to handle history cleanly
const _basecloseFolderPage = window.closeFolderPage;
window.closeFolderPage = function() {
    if (_basecloseFolderPage) _basecloseFolderPage();
};


