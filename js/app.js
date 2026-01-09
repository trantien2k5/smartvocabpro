const App = {

    info: {},
    // --- KHỞI TẠO DỮ LIỆU ---
    data: [],
    userProgress: JSON.parse(localStorage.getItem('vocab_progress')) || {},
    learningQueue: [],
    currentWordIndex: 0,
    isQuizMode: false,      // false: Flashcard, true: Quiz
    isReviewMode: false,    // false: Học mới, true: Chỉ ôn tập
    currentCorrectAnswer: "",
    activeGroup: null,
    currentFilter: 'all',

    /// --- 1. CORE: KHỞI TẠO (ĐỒNG BỘ DATA MỚI) ---
    async init() {
        try {
            console.log("🚀 Đang khởi tạo ứng dụng...");
            const DATA_PATH = './data';

            // 1. Tải dữ liệu cấu hình song song (Topics & Levels)
            const [topicsRes, levelsRes] = await Promise.all([
                fetch(`${DATA_PATH}/topics.json?v=${Date.now()}`),
                fetch(`${DATA_PATH}/levels.json?v=${Date.now()}`)
            ]);

            if (!topicsRes.ok) throw new Error("Thiếu file data/topics.json");
            
            const rawTopics = await topicsRes.json();
            const rawLevels = levelsRes.ok ? await levelsRes.json() : {}; // Level là tùy chọn

            // 2. Xử lý Mapping Level cho từng từ (để dùng sau này)
            // Biến đổi { "B1": ["tech_001"] } thành { "tech_001": "B1" } cho dễ tra cứu
            this.wordLevelMap = {};
            Object.keys(rawLevels).forEach(lvl => {
                rawLevels[lvl].forEach(wid => this.wordLevelMap[wid] = lvl);
            });

            // 3. Xây dựng danh sách Gói bài học (PackList)
            this.packList = Object.keys(rawTopics).map(key => {
                const wordIds = rawTopics[key];
                
                // Thuật toán: Tự động xác định Level của gói
                // Đếm xem trong gói này có bao nhiêu từ A1, B1... Level nào nhiều nhất thì gán cho gói.
                const levelCounts = {};
                wordIds.forEach(id => {
                    const l = this.wordLevelMap[id] || 'Unk';
                    levelCounts[l] = (levelCounts[l] || 0) + 1;
                });
                
                // Tìm level phổ biến nhất (Dominant Level)
                const dominantLevel = Object.keys(levelCounts).reduce((a, b) => levelCounts[a] > levelCounts[b] ? a : b, 'Mixed');

                return {
                    id: key,                // ID là tên Topic (vd: "Technology")
                    name: key,              // Tên hiển thị
                    word_ids: wordIds,      // Danh sách ID từ để tải sau
                    count: wordIds.length,
                    level: dominantLevel,   // Level tự động (A1, B2...)
                    icon: this.getIconForTopic(key), 
                    color: this.getColorForTopic(key)
                };
            });

            // 4. Khôi phục dữ liệu người dùng
            this.data = []; 
            await this.preloadLearnedPacks(); // Tải lại các từ đang học dở

            // 5. Setup giao diện
            if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-mode');
            const hasLearned = Object.keys(this.userProgress).length > 0;
            this.switchTab(hasLearned ? 'home' : 'topics');
            this.renderPackList(); // Vẽ menu ngay

        } catch (error) {
            console.error(error);
            alert("Lỗi khởi tạo: " + error.message);
        }
    },

    // (Giữ nguyên 2 hàm getIconForTopic và getColorForTopic của bạn ở dưới)

    // Hàm phụ trợ để sinh Icon/Màu cho đẹp (Vì data mới không có)
    getIconForTopic(name) {
        const map = {
            'Technology': 'fa-microchip', 'Daily Life': 'fa-sun', 'Business': 'fa-briefcase',
            'Environment': 'fa-leaf', 'Travel': 'fa-plane', 'Education': 'fa-graduation-cap',
            'Health': 'fa-heart-pulse', 'Food': 'fa-utensils', 'Sports': 'fa-futbol',
            'Entertainment': 'fa-film', 'Fashion': 'fa-shirt', 'Core': 'fa-star',
            'Phrasal Verbs': 'fa-code-branch', 'Idioms': 'fa-comments'
        };
        return map[name] || 'fa-folder-open';
    },
    
    getColorForTopic(name) {
        const colors = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    },

    // [FIX] Khôi phục từ vựng đã học từ file rời
    async preloadLearnedPacks() {
        const learnedWordIds = Object.keys(this.userProgress);
        if (learnedWordIds.length === 0) return;

        console.log(`📡 Đang khôi phục ${learnedWordIds.length} từ đã học...`);

        // Chỉ tải những từ chưa có trong RAM
        const idsToFetch = learnedWordIds.filter(id => !this.data.some(w => w.id === id));
        if (idsToFetch.length === 0) return;

        // Tải batch tương tự loadPack
        const chunkSize = 20;
        const restoredWords = [];

        for (let i = 0; i < idsToFetch.length; i += chunkSize) {
            const chunk = idsToFetch.slice(i, i + chunkSize);
            const promises = chunk.map(id => 
                fetch(`./data/words/${id}.json`)
                    .then(res => res.ok ? res.json() : null)
                    .catch(() => null)
            );
            const results = await Promise.all(promises);
            restoredWords.push(...results.filter(w => w !== null));
        }

        // Map và lưu vào RAM
        const mapped = restoredWords.map(w => ({
            id: w.id,
            en: w.word,
            vi: w.meaning_vi || w.meaning,
            type: w.pos,
            ipa: w.ipa,
            example: w.example_en || (w.example ? w.example.en : ""),
            level: w.level || ""
        }));

        this.data = [...this.data, ...mapped];
    },

    // --- QUẢN LÝ MỤC TIÊU NGÀY & STREAK (DAILY GOAL) ---
    getStreakInfo() {
        const today = new Date().toDateString(); // Lấy ngày hiện tại (VD: Mon Jan 01 2026)
        let data = JSON.parse(localStorage.getItem('user_streak_info')) || {
            lastDate: today,
            dailyCount: 0,      // Số từ đã học hôm nay
            currentStreak: 0,   // Chuỗi ngày liên tiếp
            target: 10          // Mục tiêu: 10 từ/ngày
        };

        // Nếu là ngày mới (khác ngày lưu gần nhất)
        if (data.lastDate !== today) {
            // Kiểm tra xem hôm qua có học không?
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);

            if (data.lastDate === yesterday.toDateString()) {
                // Hôm qua có học -> Giữ nguyên chuỗi
            } else {
                // Hôm qua bỏ học -> Reset chuỗi về 0 (Rất tiếc!)
                // Trừ trường hợp mới chơi lần đầu (streak=0)
                if (data.currentStreak > 0) data.currentStreak = 0;
            }

            // Reset đếm ngày mới
            data.lastDate = today;
            data.dailyCount = 0;
            localStorage.setItem('user_streak_info', JSON.stringify(data));
        }

        return data;
    },

    // Hàm gọi mỗi khi trả lời đúng 1 câu
    updateDailyProgress() {
        let data = this.getStreakInfo();

        data.dailyCount++;

        // Nếu vừa chạm mốc mục tiêu -> Tăng chuỗi ngay lập tức
        if (data.dailyCount === data.target) {
            data.currentStreak++;
            this.showToast(`🔥 Tuyệt vời! Bạn đã đạt chuỗi ${data.currentStreak} ngày!`, 'success');
            // Hiệu ứng ăn mừng (Confetti) nếu muốn
        }

        localStorage.setItem('user_streak_info', JSON.stringify(data));
        return data;
    },

    // --- TÍNH TOÁN TRÌNH ĐỘ (LOGIC CHỨNG CHỈ THỰC LỰC) ---
    calculateUserLevel() {
        const progress = Object.values(this.userProgress);

        // 1. Thống kê số lượng từ ĐÃ THUỘC (Level >= 3) theo từng cấp
        // Lưu ý: Chỉ tính từ đã thuộc (Level SRS >= 3), từ mới học (Level 1-2) không tính.
        let stats = { 'A1': 0, 'A2': 0, 'B1': 0, 'B2': 0, 'C1': 0, 'C2': 0 };

        progress.forEach(p => {
            if (p.level >= 3) {
                const cefr = p.cefr || 'A1'; // Nếu dữ liệu cũ không có nhãn, tạm tính A1
                if (stats[cefr] !== undefined) stats[cefr]++;
            }
        });

        // 2. Định nghĩa "Tiêu chuẩn đầu ra" (Thresholds)
        // Để đạt Level X, bạn cần thuộc ít nhất N từ của Level X
        const req = {
            'A1': 10,  // Cần thuộc 10 từ A1 để được công nhận A1
            'A2': 20,  // Cần thuộc 20 từ A2 để lên A2
            'B1': 30,  // Cần 30 từ B1
            'B2': 40,  // Cần 40 từ B2
            'C1': 50,  // Cần 50 từ C1
            'C2': 50   // Cần 50 từ C2
        };

        // 3. Xét duyệt từ cao xuống thấp (C2 -> A1)
        // Nếu đạt chuẩn C2 -> Là C2. Nếu không, xét tiếp C1...

        if (stats['C2'] >= req['C2']) return { title: "Master", level: "C2", percent: 100, next: "Max", desc: "Đã đạt đỉnh cao!" };

        if (stats['C1'] >= req['C1']) {
            const missing = req['C2'] - stats['C2'];
            return { title: "Advanced", level: "C1", percent: (stats['C2'] / req['C2']) * 100, next: "C2", desc: `Cần thuộc thêm ${missing} từ C2` };
        }

        if (stats['B2'] >= req['B2']) {
            const missing = req['C1'] - stats['C1'];
            return { title: "Upper-Inter", level: "B2", percent: (stats['C1'] / req['C1']) * 100, next: "C1", desc: `Cần thuộc thêm ${missing} từ C1` };
        }

        if (stats['B1'] >= req['B1']) {
            const missing = req['B2'] - stats['B2'];
            return { title: "Intermediate", level: "B1", percent: (stats['B2'] / req['B2']) * 100, next: "B2", desc: `Cần thuộc thêm ${missing} từ B2` };
        }

        if (stats['A2'] >= req['A2']) {
            const missing = req['B1'] - stats['B1'];
            return { title: "Elementary", level: "A2", percent: (stats['B1'] / req['B1']) * 100, next: "B1", desc: `Cần thuộc thêm ${missing} từ B1` };
        }

        if (stats['A1'] >= req['A1']) {
            const missing = req['A2'] - stats['A2'];
            return { title: "Beginner", level: "A1", percent: (stats['A2'] / req['A2']) * 100, next: "A2", desc: `Cần thuộc thêm ${missing} từ A2` };
        }

        // Nếu chưa đạt cả chuẩn A1
        const missing = req['A1'] - stats['A1'];
        return { title: "Newbie", level: "A0", percent: (stats['A1'] / req['A1']) * 100, next: "A1", desc: `Cần thuộc thêm ${missing} từ A1` };
    },
    // --- 2. NAVIGATION (ĐIỀU HƯỚNG - ĐÃ SỬA LỖI MẤT TAB) ---
    switchTab(tabName) {
        // 1. Highlight icon ở menu dưới
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        const tabIndex = { 'home': 0, 'topics': 1, 'review': 2, 'collection': 3, 'profile': 4 };
        const navItems = document.querySelectorAll('.nav-item');
        if (navItems[tabIndex[tabName]]) navItems[tabIndex[tabName]].classList.add('active');

        // 2. Reset Header & Nút Back
        const btnBack = document.getElementById('btn-back');
        if (btnBack) btnBack.style.visibility = 'hidden';

        const headerTitle = document.getElementById('header-title');
        if (headerTitle) headerTitle.innerText = "Smart Vocab Pro";

        // 3. XỬ LÝ GIAO DIỆN (QUAN TRỌNG)
        const appView = document.getElementById('app-view');

        if (tabName === 'topics') {
            // Ta sẽ dùng nó bên trong hàm renderPackList cho đúng chỗ.
            appView.innerHTML = '<div id="topics-container"></div>';
            this.renderPackList();
        } else {
            // Các tab khác thì xóa sạch app-view để vẽ mới
            appView.innerHTML = '';

            if (tabName === 'home') this.renderHome();
            else if (tabName === 'review') this.renderReview();
            else if (tabName === 'collection') this.renderCollection();
            else if (tabName === 'profile') this.renderProfile();
        }
    },



    // --- RENDER DANH SÁCH CHỦ ĐỀ (FIX CHO DATA MỚI) ---
    renderPackList() {
        const container = document.getElementById('topics-container');
        if (!container) return;
        
        container.innerHTML = '';
        document.getElementById('header-title').innerText = "Thư viện Chủ đề";

        // 1. Tạo nhóm hiển thị (Gom tất cả vào một nhóm chung vì Data mới không chia cấp độ)
        const groups = {
            library: { 
                title: "📚 Danh sách chủ đề", 
                packs: [], 
                color: "#4F46E5", 
                desc: "Tất cả bộ từ vựng" 
            }
        };

        // 2. Phân loại gói
        if (!this.packList || this.packList.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:40px; color:#64748B">
                    <i class="fa-solid fa-box-open" style="font-size:3rem; margin-bottom:15px; opacity:0.5"></i>
                    <div>Chưa có dữ liệu. Hãy kiểm tra file data/topics.json</div>
                </div>`;
            return;
        }

        this.packList.forEach(pack => {
            groups.library.packs.push(pack);
        });

        // 3. Render giao diện
        Object.values(groups).forEach(group => {
            if (group.packs.length === 0) return;

            // Tạo tiêu đề nhóm
            const groupSection = document.createElement('div');
            groupSection.className = 'topic-group';
            groupSection.innerHTML = `
                <h3 style="color:${group.color}; margin: 15px 0 15px 5px; display:flex; align-items:center; gap:10px; font-size:1.1rem">
                    ${group.title} 
                    <span style="font-size:0.85rem; color:#94a3b8; font-weight:normal; background:#F1F5F9; padding:2px 8px; border-radius:12px">
                        ${group.packs.length} gói
                    </span>
                </h3>
                <div class="topic-grid"></div>
            `;

            const grid = groupSection.querySelector('.topic-grid');

            // Render từng thẻ bài học
            group.packs.forEach(pack => {
                // Tính % tiến độ người dùng
                const userProgress = this.userProgress[pack.id] || {};
                const learnedCount = userProgress.learned || 0;
                const totalCount = pack.count || 0;
                const percent = totalCount > 0 ? Math.round((learnedCount / totalCount) * 100) : 0;
                
                // Xác định màu sắc (Fallback nếu thiếu)
                const packColor = pack.color || group.color;
                const packIcon = pack.icon || 'fa-book';

                const card = document.createElement('div');
                card.className = 'topic-card';
                card.onclick = () => this.loadPack(pack.id); // Gọi hàm loadPack khi bấm
                
                card.innerHTML = `
                    <div class="topic-icon" style="background:${packColor}15; color:${packColor}">
                        <i class="fa-solid ${packIcon}"></i>
                    </div>
                    <div class="topic-info">
                        <div class="topic-name">${pack.name}</div>
                        <div class="topic-meta" style="display:flex; justify-content:space-between; font-size:0.8rem; color:#64748B; margin-bottom:6px">
                            <span><i class="fa-solid fa-layer-group"></i> ${totalCount} từ</span>
                            ${percent > 0 ? `<span style="color:#10B981; font-weight:600">${percent}%</span>` : ''}
                        </div>
                        <div class="progress-bar-bg" style="height:6px; background:#F1F5F9; border-radius:10px; overflow:hidden">
                            <div class="progress-bar-fill" style="width:${percent}%; background:${packColor}; height:100%; border-radius:10px; transition:width 0.5s"></div>
                        </div>
                    </div>
                `;
                grid.appendChild(card);
            });

            container.appendChild(groupSection);
        });
    },
    // [FIX] Hàm tải bài học từ các file word rời rạc
    async loadPack(packId) {
        // packId lúc này chính là tên Topic (vd: "Daily Life")
        const packInfo = this.packList.find(p => p.id === packId);
        if (!packInfo) return this.showToast("Lỗi: Không tìm thấy gói này!", "error");

        this.showToast(`⏳ Đang tải ${packInfo.count} từ vựng...`, "info");

        try {
            const wordIds = packInfo.word_ids; 
            if (!wordIds || wordIds.length === 0) throw new Error("Gói này rỗng!");

            // 1. Lọc ra các từ chưa có trong RAM để tải (Tránh tải lại)
            const idsToFetch = wordIds.filter(id => !this.data.some(w => w.id === id));
            
            // 2. Tải song song (Batch fetching) - Nhanh gấp 10 lần tải tuần tự
            // Tải mỗi lần 20 file để không bị trình duyệt chặn
            const chunkSize = 20;
            const newWords = [];

            for (let i = 0; i < idsToFetch.length; i += chunkSize) {
                const chunk = idsToFetch.slice(i, i + chunkSize);
                const promises = chunk.map(id => 
                    fetch(`./data/words/${id}.json`)
                        .then(res => res.ok ? res.json() : null)
                        .catch(() => null)
                );
                
                const results = await Promise.all(promises);
                newWords.push(...results.filter(w => w !== null));
            }

            // 3. Chuẩn hóa dữ liệu (Map field mới -> cũ)
            const mappedNewWords = newWords.map(w => ({
                id: w.id,
                en: w.word,                 // Quan trọng: map 'word' -> 'en'
                vi: w.meaning_vi || w.meaning, // Quan trọng: map 'meaning' -> 'vi'
                type: w.pos,
                ipa: w.ipa,
                example: w.example_en || (w.example ? w.example.en : ""),
                level: w.level || this.wordLevelMap[w.id] || ""
            }));

            // 4. Gộp vào bộ nhớ chính
            this.data = [...this.data, ...mappedNewWords];

            // 5. Chuẩn bị dữ liệu để hiển thị
            // Lấy toàn bộ từ của gói (bao gồm cả từ cũ đã tải và từ mới vừa tải)
            const allWordsOfPack = this.data.filter(w => wordIds.includes(w.id));

            this.currentTopics = [{
                id: packId,
                name: packInfo.name,
                icon: packInfo.icon,
                words: allWordsOfPack
            }];

            this.renderTopicsOfPack(packInfo);

        } catch (e) {
            console.error(e);
            this.showToast("Lỗi tải dữ liệu: " + e.message, "error");
        }
    },
    // --- 5. HIỂN THỊ CÁC CHỦ ĐỀ CON TRONG GÓI ---
    renderTopicsOfPack(pack) {
        const container = document.getElementById('topics-container');

        // 1. Đổi tiêu đề Header thành tên Gói (Ví dụ: Technology)
        document.getElementById('header-title').innerText = pack.name;

        // 2. Hiện nút Back và gán sự kiện quay lại
        const btnBack = document.getElementById('btn-back');
        btnBack.style.visibility = 'visible';
        btnBack.onclick = () => {
            this.renderPackList(); // Quay lại danh sách gói
            btnBack.style.visibility = 'hidden'; // Ẩn nút Back đi
        };

        // 3. Vẽ danh sách chủ đề con (Logic cũ của bạn)
        const html = this.currentTopics.map(topic => {
            const total = topic.words.length;
            const learned = topic.words.filter(w => (this.userProgress[w.id]?.level || 0) > 0).length;
            const percent = Math.round((learned / total) * 100);

            return `
            <div class="topic-card" onclick="App.openTopic('${topic.id}')" style="display:block; padding:16px; margin-bottom:15px; border-left:4px solid ${percent >= 100 ? '#10B981' : pack.color}; background:var(--card-bg); border-radius:12px; box-shadow:0 2px 4px rgba(0,0,0,0.05); cursor:pointer;">
                <div style="display:flex; justify-content:space-between; align-items:center">
                    <div style="display:flex; gap:12px; align-items:center">
                        <div style="width:40px; height:40px; background:${pack.color}15; border-radius:10px; display:flex; align-items:center; justify-content:center; color:${pack.color}">
                            <i class="fa-solid ${topic.icon}"></i>
                        </div>
                        <div>
                            <h3 style="margin:0; font-size:1rem">${topic.name}</h3>
                            <div style="font-size:0.75rem; color:#94A3B8">${learned}/${total} từ vựng</div>
                        </div>
                    </div>
                    ${percent >= 100 ? '<i class="fa-solid fa-circle-check" style="color:#10B981"></i>' : '<i class="fa-solid fa-play" style="color:' + pack.color + '"></i>'}
                </div>
                ${percent > 0 ? `<div style="margin-top:10px; height:4px; background:#F1F5F9; border-radius:2px"><div style="width:${percent}%; height:100%; background:${pack.color}; border-radius:2px"></div></div>` : ''}
            </div>`;
        }).join('');

        container.innerHTML = `<div style="padding:20px">${html}</div><div style="height:60px"></div>`;
    },

    // --- 3. TIỆN ÍCH CHUNG ---
    showToast(message, type = 'info') {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }

        const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-circle-xmark' : 'fa-circle-info');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fa-solid ${icon}"></i> ${message}`;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.5s forwards';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    },

    speak(text) {
        if ('speechSynthesis' in window) {
            // Hủy câu đang đọc dở (nếu có)
            window.speechSynthesis.cancel();

            const u = new SpeechSynthesisUtterance(text);

            // 1. Lấy tốc độ từ cài đặt
            u.rate = parseFloat(localStorage.getItem('speech_rate')) || 1.0;

            // 2. Lấy danh sách giọng hiện có trong máy
            const voices = window.speechSynthesis.getVoices();

            // 3. Lấy giọng ưu tiên từ Cài đặt (Mặc định là Anh Mỹ)
            const preferredLang = localStorage.getItem('voice_lang') || 'en-US';

            // 4. Logic chọn giọng
            let selectedVoice = null;

            if (preferredLang === 'ja-JP') {
                // Mẹo: Tìm giọng Nhật để đọc tiếng Anh (ra chất Anh-Nhật)
                selectedVoice = voices.find(v => v.lang.includes('ja') || v.lang.includes('JP'));
            } else {
                // Tìm giọng Anh-Mỹ hoặc Anh-Anh chính xác
                selectedVoice = voices.find(v => v.lang === preferredLang);

                // Fallback: Nếu không tìm thấy giọng chính xác, tìm giọng có chứa mã (vd: en-US tìm giọng Google US)
                if (!selectedVoice) {
                    selectedVoice = voices.find(v => v.lang.includes(preferredLang));
                }
            }

            // Nếu tìm thấy giọng thì gán vào, không thì dùng giọng mặc định của máy
            if (selectedVoice) {
                u.voice = selectedVoice;
            }

            // Gán ngôn ngữ (Luôn là tiếng Anh để máy hiểu từ cần đọc)
            u.lang = 'en-US';

            window.speechSynthesis.speak(u);
        }
    },

    saveProgress() {
        localStorage.setItem('vocab_progress', JSON.stringify(this.userProgress));
    },

    // --- MÀN HÌNH CHÍNH (CÓ DAILY GOAL & STREAK) ---
    renderHome() {
        const userLevel = this.calculateUserLevel();
        const streakInfo = this.getStreakInfo(); // Lấy dữ liệu Streak

        // Màu sắc phân cấp
        const levelColors = {
            'A0': '#64748B', 'A1': '#10B981', 'A2': '#059669',
            'B1': '#3B82F6', 'B2': '#2563EB', 'C1': '#F59E0B', 'C2': '#DC2626'
        };
        const activeColor = levelColors[userLevel.level] || '#10B981';
        const userName = localStorage.getItem('user_name') || 'Bạn';
        const savedAvatar = localStorage.getItem('user_avatar') || '👤';

        // Tính % hoàn thành mục tiêu ngày
        const dailyPercent = Math.min((streakInfo.dailyCount / streakInfo.target) * 100, 100);

        document.getElementById('app-view').innerHTML = `
            <div style="margin-bottom:20px; display:flex; justify-content:space-between; align-items:center">
                <div style="display:flex; align-items:center; gap:12px">
                    <div onclick="App.switchTab('profile')" style="width:48px; height:48px; border-radius:50%; background:#F1F5F9; display:flex; align-items:center; justify-content:center; font-size:1.8rem; cursor:pointer; border:2px solid white; box-shadow:0 2px 10px rgba(0,0,0,0.1)">${savedAvatar}</div>
                    <div>
                        <div style="font-size:0.8rem; color:var(--text-sub);">Xin chào,</div>
                        <div style="font-size:1.1rem; font-weight:800; color:var(--text-main);">${userName}</div>
                    </div>
                </div>
                
                <div style="display:flex; align-items:center; gap:5px; background:white; padding:6px 12px; border-radius:20px; box-shadow:0 2px 8px rgba(0,0,0,0.05); border:1px solid #F1F5F9">
                    <i class="fa-solid fa-fire" style="color:#F59E0B; animation: pulse 2s infinite"></i>
                    <span style="font-weight:800; color:#F59E0B; font-size:1rem">${streakInfo.currentStreak}</span>
                </div>
            </div>

            <div style="background:white; padding:15px 20px; border-radius:20px; margin-bottom:20px; box-shadow: var(--card-shadow); border:1px solid #F1F5F9; display:flex; align-items:center; gap:15px">
                <div style="position:relative; width:50px; height:50px; display:flex; align-items:center; justify-content:center">
                    <svg width="50" height="50" viewBox="0 0 36 36" style="transform: rotate(-90deg);">
                        <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#E2E8F0" stroke-width="4" />
                        <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="${dailyPercent >= 100 ? '#10B981' : '#3B82F6'}" stroke-width="4" stroke-dasharray="${dailyPercent}, 100" />
                    </svg>
                    <div style="position:absolute; font-size:0.65rem; font-weight:bold; color:var(--text-sub)">${streakInfo.dailyCount}/${streakInfo.target}</div>
                </div>
                <div style="flex:1">
                    <div style="font-weight:700; font-size:0.95rem; margin-bottom:2px">${dailyPercent >= 100 ? 'Đã hoàn thành mục tiêu!' : 'Mục tiêu hôm nay'}</div>
                    <div style="font-size:0.8rem; color:var(--text-sub)">${dailyPercent >= 100 ? 'Giữ vững phong độ nhé 🔥' : 'Học thêm ' + (streakInfo.target - streakInfo.dailyCount) + ' từ nữa'}</div>
                </div>
                ${dailyPercent >= 100 ? '<i class="fa-solid fa-circle-check" style="color:#10B981; font-size:1.5rem"></i>' : ''}
            </div>

            <div style="background: linear-gradient(135deg, ${activeColor}, #1e293b); padding: 25px; border-radius: 20px; color: white; box-shadow: 0 10px 20px -5px ${activeColor}80; margin-bottom: 25px; position: relative; overflow: hidden;">
                <div style="position: relative; z-index: 2;">
                    <div style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.9;">Trình độ thực lực</div>
                    <div style="display:flex; align-items:baseline; gap:10px; margin: 5px 0 15px 0;">
                        <span style="font-size: 3rem; font-weight: 800; line-height: 1;">${userLevel.level}</span>
                        <span style="font-size: 1.2rem; font-weight: 500; opacity: 0.9">${userLevel.title}</span>
                    </div>
                    
                    <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 6px;">
                            <span>Tiến độ lên ${userLevel.next}</span>
                            <span style="font-weight:700">${Math.round(userLevel.percent)}%</span>
                        </div>
                        <div style="height: 8px; background: rgba(255,255,255,0.2); border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                            <div style="height: 100%; width: ${userLevel.percent}%; background: #ffffff; border-radius: 4px; transition: width 0.5s ease;"></div>
                        </div>
                        <div style="font-size: 0.75rem; opacity: 0.8;"><i class="fa-solid fa-bolt"></i> ${userLevel.desc}</div>
                    </div>
                </div>
            </div>

            <div class="section-title">Học tập</div>
            
            <div onclick="App.switchTab('topics')" style="background:white; padding:18px; border-radius:16px; box-shadow: var(--card-shadow); cursor:pointer; display:flex; align-items:center; gap:15px; margin-bottom:15px; border:1px solid #F1F5F9">
                <div style="width:45px; height:45px; background:#EEF2FF; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#4F46E5; font-size:1.2rem;">
                    <i class="fa-solid fa-plus"></i>
                </div>
                <div style="flex:1;">
                    <div style="font-weight:700; color:var(--text-main);">Học từ mới</div>
                    <div style="font-size:0.8rem; color:var(--text-sub);">Khám phá lộ trình bài bản</div>
                </div>
                <i class="fa-solid fa-chevron-right" style="color:#CBD5E1"></i>
            </div>

            <div onclick="App.switchTab('review')" style="background:white; padding:18px; border-radius:16px; box-shadow: var(--card-shadow); cursor:pointer; display:flex; align-items:center; gap:15px; border:1px solid #F1F5F9">
                <div style="width:45px; height:45px; background:#ECFDF5; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#10B981; font-size:1.2rem;">
                    <i class="fa-solid fa-rotate"></i>
                </div>
                <div style="flex:1;">
                    <div style="font-weight:700; color:var(--text-main);">Ôn tập SRS</div>
                    <div style="font-size:0.8rem; color:var(--text-sub);">Tối ưu hóa trí nhớ</div>
                </div>
                <i class="fa-solid fa-chevron-right" style="color:#CBD5E1"></i>
            </div>

            <div onclick="App.openSpeakingTool()" style="background:white; padding:18px; border-radius:16px; box-shadow: var(--card-shadow); cursor:pointer; display:flex; align-items:center; gap:15px; border:1px solid #F1F5F9; margin-top:15px">
                <div style="width:45px; height:45px; background:#FCE7F3; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#DB2777; font-size:1.2rem;">
                    <i class="fa-solid fa-microphone-lines"></i>
                </div>
                <div style="flex:1;">
                    <div style="font-weight:700; color:var(--text-main);">Luyện nói (Speaking)</div>
                    <div style="font-size:0.8rem; color:var(--text-sub);">Thực hành giao tiếp 1-1</div>
                </div>
                <i class="fa-solid fa-arrow-up-right-from-square" style="color:#CBD5E1"></i>
            </div>

            <div style="height:80px"></div>
        `;
    },


    renderReview() {
        const all = this.data.flatMap(t => t.words);
        const active = all.filter(w => (this.userProgress[w.id]?.level || 0) > 0);

        // Tính % thông thạo tổng thể
        const totalScore = active.reduce((sum, w) => sum + (this.userProgress[w.id].level || 0), 0);
        const maxScore = active.length * 6; // Level 6 là max
        const masterPercent = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

        // Từ cần ôn
        const dueWords = active.filter(w => {
            const s = this.userProgress[w.id];
            return s && s.nextReview <= Date.now();
        });

        // Vẽ vòng tròn Progress (SVG)
        const radius = 60;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (masterPercent / 100) * circumference;

        document.getElementById('app-view').innerHTML = `
            <h2 style="margin-bottom:5px">Trung tâm Ôn tập</h2>
            <p style="color:var(--text-sub); margin-top:0; margin-bottom:25px">Củng cố kiến thức mỗi ngày</p>

            <div style="background:white; padding:30px; border-radius:24px; box-shadow:var(--card-shadow); text-align:center; margin-bottom:25px; position:relative; overflow:hidden">
                <div style="position:relative; width:150px; height:150px; margin:0 auto">
                    <svg width="150" height="150">
                        <circle cx="75" cy="75" r="${radius}" stroke="#F1F5F9" stroke-width="12" fill="none"></circle>
                        <circle cx="75" cy="75" r="${radius}" stroke="var(--primary)" stroke-width="12" fill="none" 
                                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" 
                                class="progress-ring-circle"></circle>
                    </svg>
                    <div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); text-align:center">
                        <div style="font-size:2rem; font-weight:800; color:var(--text-main)">${masterPercent}%</div>
                        <div style="font-size:0.7rem; color:var(--text-sub); text-transform:uppercase; font-weight:bold">Thông thạo</div>
                    </div>
                </div>

                <div style="display:flex; justify-content:center; gap:20px; margin-top:20px">
                    <div style="text-align:center">
                        <div style="font-size:1.2rem; font-weight:bold; color:var(--tree-color)">${active.length}</div>
                        <div style="font-size:0.8rem; color:var(--text-sub)">Đã học</div>
                    </div>
                    <div style="width:1px; background:#F1F5F9"></div>
                    <div style="text-align:center">
                        <div style="font-size:1.2rem; font-weight:bold; color:var(--egg-color)">${dueWords.length}</div>
                        <div style="font-size:0.8rem; color:var(--text-sub)">Cần ôn</div>
                    </div>
                </div>
            </div>

            ${dueWords.length > 0 ? `
                <button onclick="App.startReviewMode()" style="width:100%; padding:18px; background:linear-gradient(135deg, #10B981, #059669); color:white; border:none; border-radius:20px; font-weight:700; font-size:1.1rem; box-shadow:0 10px 20px rgba(16, 185, 129, 0.3); display:flex; align-items:center; justify-content:center; gap:10px; cursor:pointer">
                    <i class="fa-solid fa-play"></i> Bắt đầu ôn tập (${dueWords.length})
                </button>
            ` : `
                <div style="background:#F0F9FF; padding:15px; border-radius:16px; border:1px dashed #BAE6FD; text-align:center; color:#0369A1">
                    <i class="fa-solid fa-mug-hot"></i> Bạn đã hoàn thành hết bài ôn tập!
                </div>
                <button onclick="App.switchTab('topics')" style="width:100%; margin-top:15px; padding:15px; background:white; color:var(--primary); border:2px solid var(--primary); border-radius:16px; font-weight:700; cursor:pointer">
                    Học từ mới
                </button>
            `}
        `;
    },

    // --- 7. LOGIC HỌC & ÔN TẬP ---
    // --- B. BẮT ĐẦU ÔN TẬP (SMART SRS LOGIC) ---
    startReviewMode() {
        const now = Date.now();
        const allWords = this.data.flatMap(t => t.words);

        // 1. Lọc ra các nhóm từ
        // - Due: Đã đến hạn ôn (Quan trọng nhất)
        const dueWords = allWords.filter(w => {
            const s = this.userProgress[w.id];
            return s && s.level > 0 && s.nextReview <= now;
        });

        // - Weak: Chưa đến hạn nhưng sức khỏe yếu (< 50%)
        const weakWords = allWords.filter(w => {
            const s = this.userProgress[w.id];
            return s && s.level > 0 && s.nextReview > now && MemoryEngine.getHealth(s) < 50;
        });

        // 2. Chọn danh sách học (Ưu tiên Due -> Weak -> Random)
        let list = [];
        let modeMsg = "";

        if (dueWords.length > 0) {
            // Ưu tiên số 1: Xử lý hàng tồn kho
            // Sắp xếp: Từ nào bị trễ lâu nhất (Overdue) học trước
            list = dueWords.sort((a, b) => this.userProgress[a.id].nextReview - this.userProgress[b.id].nextReview);
            modeMsg = `🔥 Ôn tập ${list.length} từ đến hạn`;
        } else if (weakWords.length > 0) {
            // Ưu tiên số 2: Củng cố từ yếu
            list = weakWords;
            modeMsg = `💪 Củng cố ${list.length} từ đang yếu`;
        } else {
            // Ưu tiên 3: Học ngẫu nhiên (Lấy các từ đã Master để ôn cho vui)
            const mastered = allWords.filter(w => (this.userProgress[w.id]?.level || 0) >= 6);
            if (mastered.length === 0) return this.showToast("Bạn chưa có từ vựng nào để ôn!", "error");

            list = mastered.sort(() => Math.random() - 0.5).slice(0, 20); // Lấy tối đa 20 từ
            modeMsg = `💎 Ôn luyện tự do (Gym não bộ)`;
        }

        // 3. Cắt ngắn nếu quá dài (Tránh học 1 lèo 100 từ gây nản)
        // Tài liệu nói: "Không nhồi danh sách dài" -> Cắt xuống 20 từ/lần
        if (list.length > 20) list = list.slice(0, 20);

        this.showToast(modeMsg, "info");

        // 4. Setup môi trường
        this.learningQueue = list;
        this.currentWordIndex = 0;
        this.isReviewMode = true; // Chế độ ôn tập
        this.isQuizMode = true;   // Vào thẳng bài kiểm tra (Quiz) luôn cho nhanh, không cần lật thẻ

        // Nếu muốn ôn tập nhẹ nhàng (Lật thẻ trước) thì bỏ dòng trên và set isQuizMode = false

        this.renderLearningScene();
    },
    // C. ĐIỀU PHỐI HIỂN THỊ
    renderLearningScene() {
        const container = document.getElementById('app-view');

        if (this.currentWordIndex >= this.learningQueue.length) {
            this.finishSession();
            return;
        }

        const word = this.learningQueue[this.currentWordIndex];
        const progress = ((this.currentWordIndex) / this.learningQueue.length) * 100;
        const modeTitle = this.isReviewMode ? "Ôn tập nhanh" : (this.isQuizMode ? "Kiểm tra" : "Học từ mới");

        let header = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <button onclick="App.switchTab('${this.isReviewMode ? 'review' : 'topics'}')" style="background:none; border:none; font-size:1.2rem; color:var(--text-sub)"><i class="fa-solid fa-xmark"></i></button>
                <div style="font-weight:bold; color:var(--primary)">${modeTitle}</div>
                <div style="font-size:0.9rem; color:#64748B">${this.currentWordIndex + 1}/${this.learningQueue.length}</div>
            </div>
            <div style="width:100%; height:6px; background:#E2E8F0; margin-bottom:30px; border-radius:10px; overflow:hidden">
                <div style="width:${progress}%; height:100%; background:var(--primary); transition:0.3s"></div>
            </div>
        `;

        let content = (this.isReviewMode || this.isQuizMode)
            ? this.renderQuizView(word)
            : this.renderFlashcardView(word);

        container.innerHTML = `<div class="lesson-container">${header}${content}</div>`;
    },

    // --- HÀM FLASHCARD (GIAO DIỆN RPG: CÓ THANH MÁU & RANK) ---
    renderFlashcardView(word) {
        // 1. Lấy dữ liệu sức khỏe từ Memory Engine
        const stats = this.userProgress[word.id];
        const level = stats?.level || 0;

        // Tính sức khỏe (0-100%)
        // Lưu ý: Cần file algorithm.js có hàm getHealth
        const health = MemoryEngine.getHealth(stats);

        // 2. Logic màu sắc dựa trên sức khỏe
        let healthColor = '#10B981'; // Xanh (Khỏe)
        if (health < 50) healthColor = '#F59E0B'; // Vàng (Yếu)
        if (health <= 0) healthColor = '#EF4444'; // Đỏ (Nguy kịch)

        // 3. Tên cấp độ cho ngầu
        const rankNames = ["Mới tinh", "Tập sự", "Sơ cấp", "Trung cấp", "Cao thủ", "Chuyên gia", "Thần đồng"];
        const rankName = rankNames[Math.min(level, 6)] || "Mới tinh";

        return `
            <div class="flashcard-scene" onclick="App.handleFlashcardFlip(this)">
                <div class="flashcard-inner">
                    
                    <div class="flashcard-front">
                        
                        <div style="position:absolute; top:15px; right:15px; display:flex; flex-direction:column; align-items:end; gap:5px">
                            <div style="background:${healthColor}15; color:${healthColor}; padding:4px 10px; border-radius:8px; font-size:0.7rem; font-weight:800; border:1px solid ${healthColor}40">
                                ${rankName.toUpperCase()}
                            </div>
                            <div style="width:60px; height:5px; background:#F1F5F9; border-radius:4px; overflow:hidden">
                                <div style="width:${health}%; height:100%; background:${healthColor}; transition: width 0.5s"></div>
                            </div>
                        </div>

                        <i class="fa-solid fa-graduation-cap bg-icon-decoration"></i> 
                        <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                            <div class="card-word">${word.en}</div>
                            <div class="card-ipa">${word.ipa || ''} • ${word.type || '(n)'}</div>
                            
                            <button class="btn-card-audio" onclick="event.stopPropagation(); App.speak('${word.en}')">
                                <i class="fa-solid fa-volume-high"></i>
                            </button>
                        </div>

                        <div class="flip-hint">
                            <i class="fa-regular fa-hand-pointer"></i> Chạm để lật xem nghĩa
                        </div>
                    </div>

                    <div class="flashcard-back">
                        <div class="card-meaning-box">
                            <span class="card-type">${word.type || 'Word'}</span>
                            <div class="card-meaning">${word.vi}</div>
                        </div>

                        <div class="card-example-box">
                            <div style="font-size:0.75rem; text-transform:uppercase; color:#94A3B8; margin-bottom:5px; font-weight:700">Ví dụ minh họa:</div>
                            <div class="card-example-en">
                                "${word.example || 'No example available'}"
                            </div>
                        </div>
                        
                        <div style="margin-top:20px; font-size:0.85rem; color:#64748B">
                            <i class="fa-solid fa-rotate"></i> Chạm để lật lại
                        </div>
                    </div>
                </div>
            </div>

            <button class="btn-primary" onclick="App.switchToQuiz()" style="width:100%; padding:18px; border-radius:16px; font-weight:700; font-size:1.1rem; box-shadow: 0 8px 20px rgba(79, 70, 229, 0.25); display:flex; align-items:center; justify-content:center; gap:10px; transition:0.2s">
                <i class="fa-solid fa-brain"></i> Đã nhớ, kiểm tra ngay
            </button>
        `;
    },

    // --- HÀM XỬ LÝ LẬT THẺ & ĐỌC TỰ ĐỘNG ---
    handleFlashcardFlip(element) {
        // 1. Thực hiện lật thẻ (Thêm/Bỏ class CSS)
        element.classList.toggle('is-flipped');

        // 2. Lấy từ vựng hiện tại đang học
        const word = this.learningQueue[this.currentWordIndex];

        // 3. Phát âm thanh
        if (word) {
            // Mẹo nhỏ: Delay 200ms để thẻ bắt đầu quay rồi mới đọc, cảm giác sẽ mượt hơn
            setTimeout(() => {
                this.speak(word.en);
            }, 200);
        }
    },
    switchToQuiz() {
        this.isQuizMode = true;
        this.renderLearningScene();
    },

    // --- E. VIEW QUIZ (Đã sửa lỗi không tìm thấy đáp án sai) ---
    renderQuizView(word) {
        // 1. Lấy tất cả từ vựng trong gói hiện tại để làm đáp án nhiễu
        let all = [];
        if (this.currentTopics && this.currentTopics.length > 0) {
            all = this.currentTopics.flatMap(t => t.words).map(w => w.vi);
        }

        // 2. Fallback: Nếu gói ít từ quá (dưới 4 từ) thì thêm đáp án giả để không lỗi
        if (all.length < 4) {
            all = ["Không chính xác", "Nghĩa khác", "Sai rồi", "Nhầm lẫn", ...all];
        }

        // 3. Chọn 3 đáp án sai ngẫu nhiên
        let wrongs = all.filter(m => m !== word.vi).sort(() => Math.random() - 0.5).slice(0, 3);

        // 4. Trộn với đáp án đúng
        let options = [word.vi, ...wrongs].sort(() => Math.random() - 0.5);
        this.currentCorrectAnswer = word.vi;

        const buttons = options.map(opt =>
            `<button class="quiz-opt-btn" onclick="App.handleQuizResult(this, '${opt}')">
                ${opt} <i class="fa-regular fa-circle" style="color:#CBD5E1"></i>
            </button>`
        ).join('');

        return `
            <div class="lesson-card">
                <div class="quiz-question-box">
                    <div style="font-size:0.9rem; color:#64748B; margin-bottom:5px;">TỪ NÀY NGHĨA LÀ GÌ?</div>
                    <div class="quiz-word">${word.en}</div>
                    <button onclick="App.speak('${word.en}')" style="background:#F1F5F9; border:none; width:40px; height:40px; border-radius:50%; margin-top:5px"><i class="fa-solid fa-volume-high" style="color:var(--primary)"></i></button>
                </div>
                <div class="quiz-options-grid">${buttons}</div>
                <div style="height: 100px;"></div> </div>
            <div id="result-sheet-container"></div>
        `;
    },

    // --- XỬ LÝ KẾT QUẢ (LOGIC CEFR MỚI) ---
    handleQuizResult(btn, selected) {
        const correct = this.currentCorrectAnswer;
        const word = this.learningQueue[this.currentWordIndex];

        // 1. Khóa nút
        document.querySelectorAll('.quiz-opt-btn').forEach(b => b.style.pointerEvents = 'none');

        // 2. Hiện đáp án đúng/sai trên giao diện
        document.querySelectorAll('.quiz-opt-btn').forEach(b => {
            if (b.innerText.trim() === correct) {
                b.classList.add('correct');
                b.querySelector('i').className = 'fa-solid fa-circle-check';
            }
        });
        const isCorrect = selected === correct;
        if (isCorrect) {
            btn.classList.add('correct');
            this.updateDailyProgress();
        } else {
            btn.classList.add('wrong');
            btn.querySelector('i').className = 'fa-solid fa-circle-xmark';
        }

        // 3. [QUAN TRỌNG] GỌI THUẬT TOÁN & LƯU LEVEL CEFR
        const currentStats = this.userProgress[word.id] || null;

        // Gọi thuật toán SRS (để tính ngày ôn)
        const newStats = MemoryEngine.processResult(currentStats, isCorrect);

        // 🔥 LƯU LEVEL VÀO TIẾN ĐỘ ĐỂ TÍNH ĐIỂM (Đây là dòng quan trọng nhất)
        // Nếu file data không có level, mặc định là A1
        newStats.cefr = word.level || 'A1';

        this.userProgress[word.id] = newStats;
        this.saveProgress();

        // 4. Hiển thị kết quả (Bottom Sheet)
        const sheetContainer = document.getElementById('result-sheet-container');
        const headerIcon = isCorrect ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-xmark"></i>';
        const headerText = isCorrect ? 'Chính xác!' : 'Chưa chính xác';
        const sheetClass = isCorrect ? 'correct' : 'wrong';
        const btnColor = isCorrect ? '#10B981' : '#F59E0B';

        sheetContainer.innerHTML = `
            <div class="result-sheet ${sheetClass} show">
                <div class="sheet-header ${sheetClass}">
                    ${headerIcon} ${headerText}
                </div>
                <div class="sheet-info-box">
                    <div class="sheet-word-row">
                        <span class="sheet-word">${word.en}</span>
                        <span class="sheet-ipa">${word.ipa || ''} • <span style="color:${isCorrect ? '#10B981' : '#EF4444'}; font-weight:bold">${newStats.cefr}</span></span>
                        <i class="fa-solid fa-volume-high" onclick="App.speak('${word.en}')" style="color:var(--primary)"></i>
                    </div>
                    <div class="sheet-meaning">${word.vi}</div>
                    <div class="sheet-example">"${word.example || ''}"</div>
                </div>
                <button class="btn-sheet-action" onclick="App.nextWord()" style="background:${btnColor}">
                    ${isCorrect ? 'Tiếp tục' : 'Đã hiểu, tiếp tục'} <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>
        `;
    },
    nextWord() {
        this.currentWordIndex++;
        if (!this.isReviewMode) {
            this.isQuizMode = false;
        }
        this.renderLearningScene();
    },

    finishSession() {
        const tabToReturn = this.isReviewMode ? 'review' : 'topics';
        this.checkLevelUp();
        document.getElementById('app-view').innerHTML = `
            <div style="text-align:center; padding-top:60px; animation:slideUp 0.5s ease">
                <div style="width:120px; height:120px; background:#FEF3C7; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 30px auto; box-shadow: 0 10px 30px rgba(245, 158, 11, 0.3);">
                    <i class="fa-solid fa-trophy" style="font-size:4rem; color:#F59E0B;"></i>
                </div>
                <h2>Hoàn thành xuất sắc!</h2>
                <p style="color:#64748B; margin-bottom:30px">Bạn đã hoàn thành phiên học này.</p>
                <button class="btn-primary" onclick="App.switchTab('${tabToReturn}')" style="padding:15px 40px; border-radius:30px">Quay về</button>
            </div>
        `;
    },

    // --- 8. TAB SỔ TAY (PHIÊN BẢN RPG: TIẾN HÓA TỪ VỰNG) ---
    renderCollection() {
        // 1. Lấy dữ liệu & Thống kê
        const all = this.data.flatMap(t => t.words);
        const active = all.filter(w => (this.userProgress[w.id]?.level || 0) > 0);

        // Phân loại theo cấp độ RPG
        const stats = {
            egg: active.filter(w => (this.userProgress[w.id]?.level || 0) === 1).length,    // Mầm non
            sprout: active.filter(w => [2, 3].includes(this.userProgress[w.id]?.level)).length, // Đang lớn
            tree: active.filter(w => [4, 5].includes(this.userProgress[w.id]?.level)).length,   // Trưởng thành
            diamond: active.filter(w => (this.userProgress[w.id]?.level || 0) >= 6).length     // Vĩnh cửu
        };

        // 2. Render Giao diện
        document.getElementById('app-view').innerHTML = `
            <div class="sticky-header" style="background:var(--bg-color); padding-bottom:10px">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-top:10px">
                    <div>
                        <h2 style="margin:0; font-size:1.5rem; color:var(--text-main)">Kho tàng từ vựng</h2>
                        <p style="margin:0; color:var(--text-sub); font-size:0.9rem">Bộ sưu tập tiến hóa của bạn</p>
                    </div>
                    <button onclick="App.switchTab('topics')" style="width:40px; height:40px; border-radius:12px; border:none; background:var(--primary); color:white; font-size:1.2rem; cursor:pointer; box-shadow:0 4px 10px rgba(99, 102, 241, 0.3)">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:20px; overflow-x:auto; padding-bottom:5px;" class="hide-scrollbar">
                    <div class="stat-badge" style="background:#FFF7ED; color:#9A3412; border:1px solid #FFEDD5">
                        <span>🥚 Mới: <b>${stats.egg}</b></span>
                    </div>
                    <div class="stat-badge" style="background:#ECFDF5; color:#065F46; border:1px solid #D1FAE5">
                        <span>🌱 Đang lớn: <b>${stats.sprout}</b></span>
                    </div>
                    <div class="stat-badge" style="background:#EFF6FF; color:#1E40AF; border:1px solid #DBEAFE">
                        <span>🌳 Cứng cáp: <b>${stats.tree}</b></span>
                    </div>
                    <div class="stat-badge" style="background:#F3E8FF; color:#6B21A8; border:1px solid #E9D5FF">
                        <span>💎 Vĩnh cửu: <b>${stats.diamond}</b></span>
                    </div>
                </div>

                <div class="search-box" style="box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin-bottom:15px">
                    <i class="fa-solid fa-magnifying-glass" style="color:#94A3B8"></i>
                    <input type="text" id="search-input" placeholder="Tìm kiếm kho tàng..." onkeyup="App.filterCollection()">
                </div>
            </div>

            <div id="collection-list" class="collection-container" style="padding-bottom:100px"></div>
            
            <div id="word-detail-modal" class="word-detail-modal" onclick="if(event.target===this) App.closeDetailModal()">
                <div class="detail-card" id="detail-card-content"></div>
            </div>
        `;

        this.filterCollection();
    },



    setFilter(btn, type) {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = type;
        this.filterCollection();
    },

    // --- HÀM VẼ DANH SÁCH (COPY ĐÈ HÀM NÀY VÀO LÀ HẾT LỖI) ---
    filterCollection() {
        const query = document.getElementById('search-input').value.toLowerCase();
        const container = document.getElementById('collection-list');

        let words = this.data.flatMap(t => t.words);

        // 1. Chỉ lấy từ đã học
        words = words.filter(w => {
            const lvl = this.userProgress[w.id]?.level || 0;
            if (lvl === 0) return false;
            if (query && !w.en.toLowerCase().includes(query) && !w.vi.toLowerCase().includes(query)) return false;
            return true;
        });

        // 2. Sắp xếp: Mới học lên đầu
        words.sort((a, b) => (this.userProgress[b.id]?.lastReview || 0) - (this.userProgress[a.id]?.lastReview || 0));

        // 3. Xử lý khi trống
        if (words.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding-top:50px; opacity:0.6">
                    <i class="fa-solid fa-box-open" style="font-size:3rem; color:#CBD5E1"></i>
                    <p>Chưa có gì trong kho tàng.</p>
                </div>`;
            return;
        }

        // 4. Render danh sách (CÓ ICON RPG)
        container.innerHTML = words.map(w => {
            const stats = this.userProgress[w.id];
            const lvl = stats.level || 0;

            // Logic Icon & Màu sắc
            let icon = '🥚'; let color = '#F59E0B'; let rankName = 'Mầm non'; let bg = '#FFF7ED';

            if (lvl >= 2 && lvl <= 3) { icon = '🌱'; color = '#10B981'; rankName = 'Đang lớn'; bg = '#ECFDF5'; }
            else if (lvl >= 4 && lvl <= 5) { icon = '🌳'; color = '#3B82F6'; rankName = 'Trưởng thành'; bg = '#EFF6FF'; }
            else if (lvl >= 6) { icon = '💎'; color = '#8B5CF6'; rankName = 'Vĩnh cửu'; bg = '#F3E8FF'; }

            // LƯU Ý QUAN TRỌNG: Thêm 'border-left: none' để xóa cái vạch vàng cũ
            return `
            <div class="word-row" onclick="App.openWordDetail('${w.id}')" style="align-items:center; border-left: none !important; padding-left: 10px;">
                
                <div style="min-width:45px; width:45px; height:45px; background:${bg}; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.5rem; margin-right:12px; border:1px solid ${color}30">
                    ${icon}
                </div>

                <div class="word-row-left" style="flex:1">
                    <div class="word-en" style="display:flex; align-items:center; gap:8px">
                        ${w.en}
                        <span style="font-size:0.6rem; padding:2px 6px; border-radius:4px; background:${bg}; color:${color}; font-weight:700; border:1px solid ${color}20">
                            ${rankName.toUpperCase()}
                        </span>
                    </div>
                    <div class="word-meta">${w.vi}</div>
                </div>

                <button onclick="event.stopPropagation(); App.speak('${w.en}')" style="width:36px; height:36px; border-radius:50%; border:none; background:#F8FAFC; color:var(--text-sub); cursor:pointer">
                    <i class="fa-solid fa-volume-high"></i>
                </button>
            </div>`;
        }).join('');
    },

    openWordDetail(wordId) {
        const word = this.data.flatMap(t => t.words).find(w => w.id == wordId);
        if (!word) return;

        const lvl = this.userProgress[wordId]?.level || 0;
        const isMastered = lvl >= 3;
        const color = isMastered ? '#10B981' : '#F59E0B';
        const text = isMastered ? 'Đã thuộc lòng' : 'Đang học';

        document.getElementById('detail-card-content').innerHTML = `
            <div class="detail-header">
                <button class="detail-close" onclick="App.closeDetailModal()"><i class="fa-solid fa-xmark"></i></button>
                <div class="detail-word-en">${word.en}</div>
                <div class="detail-ipa">${word.ipa || ''}</div>
                <button class="btn-speak-floating" onclick="App.speak('${word.en}')"><i class="fa-solid fa-volume-high"></i></button>
            </div>
            <div class="detail-body">
                <div style="margin-bottom:5px"><span class="detail-type-badge">${word.type || 'word'}</span></div>
                <div class="detail-meaning">${word.vi}</div>
                <div class="detail-example-box">
                    <div style="color:#64748B; font-size:0.9rem; font-style:italic; margin-bottom:5px">Ví dụ:</div>
                    <div style="color:#334155; line-height:1.4">"${word.example}"</div>
                </div>
                <div class="detail-footer">
                    <div style="display:flex; flex-direction:column; align-items:flex-start">
                        <span style="font-weight:600; color:${color}">${text}</span>
                        <span>Level ${lvl}/3</span>
                    </div>
                    <div style="width:100px; height:8px; background:#F1F5F9; border-radius:10px; overflow:hidden">
                        <div style="width:${(lvl / 3) * 100}%; height:100%; background:${color}; transition:0.5s"></div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('word-detail-modal').classList.add('show');
    },

    closeDetailModal() {
        document.getElementById('word-detail-modal').classList.remove('show');
    },

    // --- 9. TAB PROFILE (ĐÃ FIX: KHÔNG RENDER LẠI MODAL) ---
    renderProfile() {
        const name = localStorage.getItem('user_name') || 'Bạn';
        const savedAvatar = localStorage.getItem('user_avatar');
        const userAvatarDisplay = savedAvatar ? savedAvatar : name.slice(0, 2).toUpperCase();
        const isDark = localStorage.getItem('theme') === 'dark';
        const speed = parseFloat(localStorage.getItem('speech_rate')) || 1.0;
        const currentVoice = localStorage.getItem('voice_lang') || 'en-US';

        const voiceMap = {
            'en-US': { flag: '🇺🇸', name: 'Anh - Mỹ' },
            'en-GB': { flag: '🇬🇧', name: 'Anh - Anh' },
            'ja-JP': { flag: '🇯🇵', name: 'Anh - Nhật' }
        };
        const activeVoice = voiceMap[currentVoice] || voiceMap['en-US'];

        // CHỈ RENDER PHẦN GIAO DIỆN CHÍNH, KHÔNG RENDER MODAL
        document.getElementById('app-view').innerHTML = `
            <h2 style="margin-bottom:15px">Cài đặt</h2>
            
           <div style="background:linear-gradient(135deg, #6366f1, #4f46e5); padding:20px; border-radius:20px; color:white; display:flex; align-items:center; gap:15px; margin-bottom:25px; box-shadow:0 10px 25px rgba(79,70,229,0.3)">
                <div class="profile-avatar-wrapper" onclick="App.openAvatarModal()">
                    <div class="user-avatar" style="background:rgba(255,255,255,0.2); border:2px solid rgba(255,255,255,0.5); font-size:${savedAvatar ? '1.5rem' : '1rem'}; color:white">
                        ${userAvatarDisplay}
                    </div>
                    <div class="avatar-edit-icon"><i class="fa-solid fa-camera"></i></div>
                </div>
                
                <div style="flex:1">
                    <div style="font-weight:700; font-size:1.2rem">${name}</div>
                    <div style="font-size:0.85rem; opacity:0.9">Thành viên Pro • <span onclick="App.editName()" style="text-decoration:underline; cursor:pointer">Đổi tên</span></div>
                </div>
            </div>

            <div class="setting-section-title">Học tập & Giao diện</div>
            <div class="setting-card">
                <div class="setting-row" onclick="App.openVoiceSheet()">
                    <div class="st-left">
                        <div class="st-icon" style="background:#8B5CF6"><i class="fa-solid fa-earth-americas"></i></div>
                        <div class="st-text"><h4>Giọng đọc</h4><p>Accent phát âm</p></div>
                    </div>
                    <div class="st-right">
                        <div class="voice-trigger-btn">
                            <span class="voice-flag">${activeVoice.flag}</span>
                            <span>${activeVoice.name}</span>
                            <i class="fa-solid fa-chevron-right" style="font-size:0.8rem; color:#CBD5E1; margin-left:5px"></i>
                        </div>
                    </div>
                </div>

                <div class="setting-row">
                    <div class="st-left"><div class="st-icon" style="background:#F59E0B"><i class="fa-solid fa-gauge-high"></i></div><div class="st-text"><h4>Tốc độ đọc</h4><p>Chỉnh giọng chậm/nhanh</p></div></div>
                    <div class="st-right"><span id="speed-label" style="font-weight:bold; width:30px; text-align:right;">${speed}x</span><input type="range" class="speed-slider" min="0.5" max="1.5" step="0.1" value="${speed}" oninput="App.setSpeed(this.value)"></div>
                </div>

                <div class="setting-row">
                    <div class="st-left"><div class="st-icon" style="background:#3B82F6"><i class="fa-solid fa-moon"></i></div><div class="st-text"><h4>Chế độ tối</h4><p>Bảo vệ mắt ban đêm</p></div></div>
                    <div class="st-right"><label class="switch"><input type="checkbox" onchange="App.toggleTheme()" ${isDark ? 'checked' : ''}><span class="slider"></span></label></div>
                </div>
            </div>

            <div class="setting-section-title">Dữ liệu & Chia sẻ</div>
            <div class="setting-card">
                <div class="setting-row" onclick="App.showExportModal()">
                    <div class="st-left"><div class="st-icon" style="background:#8B5CF6"><i class="fa-solid fa-file-pdf"></i></div><div class="st-text"><h4>Xuất file PDF</h4><p>Tải danh sách từ vựng</p></div></div>
                    <div class="st-right"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                <div class="setting-row" onclick="App.backupData()">
                    <div class="st-left"><div class="st-icon" style="background:#0EA5E9"><i class="fa-solid fa-cloud-arrow-down"></i></div><div class="st-text"><h4>Sao lưu tiến độ</h4><p>Tải file về máy tính</p></div></div>
                    <div class="st-right"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                <div class="setting-row" onclick="document.getElementById('file-restore').click()">
                    <div class="st-left"><div class="st-icon" style="background:#10B981"><i class="fa-solid fa-cloud-arrow-up"></i></div><div class="st-text"><h4>Khôi phục dữ liệu</h4><p>Nạp lại file đã lưu</p></div></div>
                    <div class="st-right"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                <input type="file" id="file-restore" style="display:none" accept=".json" onchange="App.restoreData(this)">
            </div>

            <div class="setting-section-title">Hệ thống</div>
            <div class="setting-card">
                <div class="setting-row" onclick="App.showUpdateModal()">
                    <div class="st-left"><div class="st-icon" style="background:#8B5CF6"><i class="fa-solid fa-rocket"></i></div><div class="st-text"><h4>Tính năng mới</h4><p>Xem thông tin bản cập nhật</p></div></div>
                    <div class="st-right"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
                <div class="setting-row" onclick="App.resetData()">
                    <div class="st-left"><div class="st-icon" style="background:#EF4444"><i class="fa-solid fa-trash-can"></i></div><div class="st-text"><h4>Xóa dữ liệu</h4><p style="color:#EF4444">Đặt lại tiến độ về 0</p></div></div>
                </div>
            </div>

            <div style="height:80px"></div>

            <div class="setting-row" onclick="App.openDataDashboard()">
        <div class="st-left">
            <div class="st-icon" style="background:#6366F1"><i class="fa-solid fa-server"></i></div>
            <div class="st-text"><h4>Dữ liệu hệ thống</h4><p>Xem cấu trúc File, Cache & Index</p></div>
        </div>
        <div class="st-right"><i class="fa-solid fa-chevron-right"></i></div>
    </div>
        `;
    },
    // --- CÁC HÀM XỬ LÝ CHỌN GIỌNG MỚI ---
    openVoiceSheet() {
        document.getElementById('voice-sheet-overlay').classList.add('show');
    },

    closeVoiceSheet() {
        document.getElementById('voice-sheet-overlay').classList.remove('show');
    },

    setVoiceNew(langCode) {
        // 1. Lưu cài đặt
        localStorage.setItem('voice_lang', langCode);

        // 2. Đóng menu
        this.closeVoiceSheet();

        // 3. Thông báo và cập nhật giao diện
        this.showToast("Đã đổi giọng đọc!", "success");

        // Cập nhật lại giao diện Profile để hiện cờ mới
        setTimeout(() => {
            this.renderProfile();
            // Đọc thử 1 câu để test
            this.speak("Voice setting updated successfully");
        }, 300);
    },


    // --- HỆ THỐNG CẬP NHẬT TỰ ĐỘNG (DÙNG FILE JSON) ---
    checkUpdate() {
        if (!this.info || !this.info.version) return;

        const savedVer = localStorage.getItem('app_version');

        // So sánh version trong file JSON với version đã lưu trong máy
        if (savedVer !== this.info.version) {
            setTimeout(() => {
                this.showUpdateModal();
                localStorage.setItem('app_version', this.info.version);
            }, 2000);
        }
    },

    showUpdateModal() {
        // Lấy danh sách tính năng từ file JSON (hoặc dùng mặc định nếu lỗi)
        const features = this.info.features || ["✨ Cải thiện hiệu năng và sửa lỗi."];

        const listHTML = features.map(f => `
            <div class="update-item">
                <i class="fa-solid fa-circle-check"></i>
                <div>${f}</div>
            </div>
        `).join('');

        const modalHTML = `
            <div id="update-modal" class="modal-overlay show" style="z-index:99999;">
                <div class="modal-box update-box">
                    <div class="update-header-img">
                        <i class="fa-solid fa-rocket"></i>
                    </div>
                    <div class="update-badge">Cập nhật v${this.info.version}</div>
                    <h2 style="margin:0 0 10px 0; color:var(--text-main)">Có gì mới?</h2>
                    <p style="margin:0; color:var(--text-sub); font-size:0.9rem">Phiên bản ngày ${this.info.last_updated}</p>
                    
                    <div class="update-list">${listHTML}</div>

                    <button class="btn-primary" onclick="document.getElementById('update-modal').remove()" style="width:100%; padding:15px; border-radius:15px; font-weight:bold; font-size:1rem; box-shadow: 0 5px 15px rgba(79, 70, 229, 0.3);">
                        Tuyệt vời!
                    </button>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    },

    editName() {
        document.getElementById('input-new-name').value = localStorage.getItem('user_name') || "";
        document.getElementById('name-modal').classList.add('show');
    },
    closeModal(id) { document.getElementById(id).classList.remove('show'); },
    saveNewName() {
        const val = document.getElementById('input-new-name').value.trim();
        if (val) { localStorage.setItem('user_name', val); this.closeModal('name-modal'); this.renderProfile(); }
    },

    setSpeed(val) { localStorage.setItem('speech_rate', val); document.getElementById('speed-label').innerText = val + 'x'; },
    toggleTheme() { document.body.classList.toggle('dark-mode'); localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); },
    resetData() { if (confirm("Xóa toàn bộ tiến độ học tập?")) { localStorage.removeItem('vocab_progress'); location.reload(); } },
    // Hàm lưu giọng đọc
    setVoice(langCode) {
        localStorage.setItem('voice_lang', langCode);
        this.showToast("Đã đổi giọng đọc!", "success");

        // Đọc thử một câu mẫu để test giọng
        setTimeout(() => this.speak("Hello, welcome to Smart Vocab"), 300);
    },
    backupData() {
        const data = { progress: this.userProgress, name: localStorage.getItem('user_name'), date: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `SmartVocab_Backup.json`; a.click();
    },
    restoreData(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const backup = JSON.parse(e.target.result);
                if (backup.progress) {
                    localStorage.setItem('vocab_progress', JSON.stringify(backup.progress));
                    if (backup.name) localStorage.setItem('user_name', backup.name);
                    alert("Khôi phục thành công!"); location.reload();
                } else alert("File không hợp lệ.");
            } catch (err) { alert("Lỗi đọc file."); }
        };
        reader.readAsText(file);
    },

    showExportModal() {
        const groups = [...new Set(this.data.map(i => i.group))];
        let html = `<div class="export-option-row"><input type="checkbox" id="chk-all" checked onchange="document.querySelectorAll('.chk-g').forEach(c=>c.checked=this.checked)"><label><b>Chọn tất cả</b></label></div>`;
        groups.forEach((g, i) => {
            html += `<div class="export-option-row"><input type="checkbox" class="chk-g" value="${g}" checked><label>${g}</label></div>`;
        });
        document.getElementById('export-list').innerHTML = html;
        document.getElementById('export-modal').classList.add('show');
    },
    
    // [FIX] Xuất file PDF chuẩn cho Data mới
    exportPDF() {
        // 1. Kiểm tra xem đang mở bài nào không
        if (!this.currentTopics || this.currentTopics.length === 0) {
            return this.showToast("Hãy mở một bài học trước khi xuất file!", "error");
        }

        this.showToast("⏳ Đang tạo file PDF...", "info");

        // 2. Lấy danh sách từ vựng hiện tại
        // Data mới: [{ words: [...] }] hoặc [{ id:..., words: [...] }]
        let wordsToExport = [];
        if (Array.isArray(this.currentTopics)) {
            wordsToExport = this.currentTopics.flatMap(t => t.words || []);
        } else if (this.currentTopics.words) {
            wordsToExport = this.currentTopics.words;
        }

        if (wordsToExport.length === 0) return this.showToast("Không có từ vựng nào để xuất!", "error");

        // 3. Cấu hình nội dung PDF
        const docDefinition = {
            content: [
                { text: `Danh sách từ vựng: ${this.currentTopics[0]?.name || 'Topic'}`, style: 'header' },
                { text: `Tổng số từ: ${wordsToExport.length}`, style: 'subheader' },
                {
                    style: 'tableExample',
                    table: {
                        headerRows: 1,
                        widths: ['auto', '*', '*', 'auto'],
                        body: [
                            [
                                { text: 'STT', style: 'tableHeader' }, 
                                { text: 'Từ vựng (Word)', style: 'tableHeader' }, 
                                { text: 'Nghĩa (Meaning)', style: 'tableHeader' }, 
                                { text: 'Loại', style: 'tableHeader' }
                            ],
                            // Map dữ liệu mới vào bảng
                            ...wordsToExport.map((w, index) => [
                                index + 1,
                                { text: w.en || "", bold: true }, // Data mới dùng w.en
                                w.vi || "",                       // Data mới dùng w.vi
                                { text: w.type || "", italics: true, color: 'gray' }
                            ])
                        ]
                    },
                    layout: 'lightHorizontalLines'
                }
            ],
            styles: {
                header: { fontSize: 18, bold: true, margin: [0, 0, 0, 10], color: '#4F46E5' },
                subheader: { fontSize: 14, bold: true, margin: [0, 0, 0, 20], color: '#64748B' },
                tableHeader: { bold: true, fontSize: 13, color: 'black', fillColor: '#F1F5F9' },
                tableExample: { margin: [0, 5, 0, 15] }
            },
            defaultStyle: { font: 'Roboto' } // Dùng font mặc định của pdfmake
        };

        // 4. Tạo và tải file
        try {
            pdfMake.createPdf(docDefinition).download(`Vocab_${this.currentTopics[0]?.id || 'list'}.pdf`);
            this.showToast("✅ Đã xuất file PDF thành công!", "success");
            this.closeModal('export-modal'); // Đóng modal nếu có
        } catch (e) {
            console.error(e);
            this.showToast("Lỗi tạo PDF: " + e.message, "error");
        }
    },

    // --- LOGIC THAY ĐỔI AVATAR ---
    openAvatarModal() {
        // Danh sách Avatar để chọn
        const avatars = ['🦁', '🦊', '🐱', '🐶', '🦄', '🐸', '🐷', '🐨', '🐼', '🐯', '🤖', '👻', '💀', '👽', '🚀', '⭐', '🎓', '⚽', '🏀', '🎮'];

        const current = localStorage.getItem('user_avatar') || '';

        const html = avatars.map(avt => `
            <div class="avatar-option ${avt === current ? 'selected' : ''}" onclick="App.saveAvatar('${avt}')">
                ${avt}
            </div>
        `).join('');

        // Thêm tùy chọn "Chữ cái tên" (Mặc định)
        const nameAvt = (localStorage.getItem('user_name') || 'A').slice(0, 2).toUpperCase();
        const defaultOption = `
            <div class="avatar-option ${current === '' ? 'selected' : ''}" onclick="App.saveAvatar('')" style="font-size:1.2rem; font-weight:bold; color:var(--primary)">
                ${nameAvt}
            </div>
        `;

        document.getElementById('avatar-grid-content').innerHTML = defaultOption + html;
        document.getElementById('avatar-modal').classList.add('show');
    },

    saveAvatar(emoji) {
        localStorage.setItem('user_avatar', emoji);
        this.showToast("Đã cập nhật Avatar!", "success");
        this.closeModal('avatar-modal');
        this.renderProfile(); // Vẽ lại giao diện ngay
    },

    // --- HÀM VÀO HỌC (BẮT BUỘC CÓ) ---
    openTopic(topicId) {
        // 1. Tìm chủ đề trong biến currentTopics (dữ liệu gói đang mở)
        const topic = this.currentTopics.find(t => t.id === topicId);

        if (!topic) {
            console.error("Không tìm thấy topic:", topicId);
            return;
        }

        // 2. Lọc từ chưa thuộc (Level < 3)
        let list = topic.words.filter(w => (this.userProgress[w.id]?.level || 0) < 3);

        // 3. Nếu thuộc hết thì hỏi ôn lại
        if (list.length === 0) {
            if (confirm("Bạn đã thuộc hết chủ đề này. Ôn tập lại nhé?")) {
                list = [...topic.words];
            } else {
                return;
            }
        }

        // 4. Setup hàng đợi học
        this.learningQueue = list.sort(() => Math.random() - 0.5).slice(0, 5);
        this.currentWordIndex = 0;
        this.isReviewMode = false;
        this.isQuizMode = false;

        // 5. Chuyển cảnh
        this.renderLearningScene();
    },

    // --- TÍNH NĂNG TRA TỪ ĐIỂN (FIX LỖI POPUP) ---
    openDictionary() {
        document.getElementById('dict-input').value = '';
        document.getElementById('dict-modal').classList.add('show');
        // Tự động trỏ chuột vào ô nhập cho tiện
        setTimeout(() => document.getElementById('dict-input').focus(), 100);
    },

    // --- HIỆU ỨNG CHÚC MỪNG LÊN CẤP ---
    checkLevelUp() {
        const oldLevel = localStorage.getItem('last_user_level') || 'A0';
        const currentStats = this.calculateUserLevel();

        // Nếu Level mới cao hơn Level cũ
        if (currentStats.level !== oldLevel) {
            // Lưu lại level mới
            localStorage.setItem('last_user_level', currentStats.level);

            // Hiện Modal Chúc mừng
            const modalHTML = `
                <div id="levelup-modal" class="modal-overlay show" style="z-index:99999">
                    <div class="modal-box" style="text-align:center; background:linear-gradient(135deg, #4F46E5, #8B5CF6); color:white;">
                        <div style="font-size:4rem; margin-bottom:10px">🎉</div>
                        <h2 style="font-size:1.8rem; margin:0">THĂNG CẤP!</h2>
                        <p style="opacity:0.9">Bạn đã đạt trình độ <b>${currentStats.level}</b></p>
                        
                        <div style="background:rgba(255,255,255,0.2); padding:15px; border-radius:15px; margin:20px 0; font-size:0.9rem">
                            🔓 Đã mở khóa các bài học mới!
                        </div>

                        <button onclick="document.getElementById('levelup-modal').remove()" style="background:white; color:#4F46E5; width:100%; padding:15px; border-radius:15px; font-weight:bold; border:none; cursor:pointer; font-size:1rem">
                            Tuyệt vời
                        </button>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHTML);

            // Phát âm thanh ăn mừng (Nếu muốn)
            // const audio = new Audio('assets/levelup.mp3'); audio.play();
        }
    },

    // --- TÍNH NĂNG TÌM KIẾM THÔNG MINH (SMART SEARCH) ---
    async searchDict() {
        const query = document.getElementById('dict-input').value.trim().toLowerCase();
        if (!query) return;

        // 1. Tìm trong bộ nhớ đã tải trước (Ưu tiên từ đã học)
        const localMatch = this.data.find(w => w.en.toLowerCase() === query);
        if (localMatch) {
            this.closeModal('dict-modal');
            this.openWordDetail(localMatch.id); // Mở chi tiết ngay
            return;
        }

        // 2. Nếu không thấy, tra cứu trong Index (Tìm từ chưa học)
        try {
            // Tải file index (nếu chưa tải)
            if (!this.searchIndex) {
                const res = await fetch('./data/search_index.json');
                this.searchIndex = res.ok ? await res.json() : {};
            }

            const targetPackId = this.searchIndex[query];

            if (targetPackId) {
                // TÌM THẤY! Nó nằm trong gói targetPackId
                if (confirm(`Từ "${query}" có trong bài học! Bạn có muốn mở bài chứa từ này không?`)) {
                    this.closeModal('dict-modal');
                    await this.loadPack(targetPackId); // Tải gói đó về

                    // Sau khi tải xong, tìm lại và mở chi tiết
                    setTimeout(() => {
                        const w = this.data.find(x => x.en.toLowerCase() === query);
                        if (w) this.openWordDetail(w.id);
                    }, 500);
                }
                return;
            }
        } catch (e) {
            console.error("Lỗi tìm kiếm Index:", e);
        }

        // 3. Nếu vẫn không thấy -> Mở từ điển Cambridge (Fallback)
        const width = 450;
        const height = 700;
        const left = (screen.width - width) / 2;
        const top = (screen.height - height) / 2;

        window.open(
            `https://dictionary.cambridge.org/dictionary/english/${query}`,
            'SmartVocabDict',
            `width=${width},height=${height},top=${top},left=${left},scrollbars=yes,resizable=yes`
        );
        this.closeModal('dict-modal');
    },

    // --- CÔNG CỤ TẠO INDEX TÌM KIẾM (DEV TOOL) ---
    // Cách dùng: Mở App, mở Console (F12), gõ App.buildSearchIndex()
    async buildSearchIndex() {
        console.log("🛠️ Đang quét toàn bộ dữ liệu để tạo Index...");

        // 1. Tải danh sách tất cả các gói
        const indexRes = await fetch('./data/topics_index.json');
        const packList = await indexRes.json();

        let fullIndex = {};

        // 2. Đi từng gói để lấy từ vựng
        for (const pack of packList) {
            try {
                const res = await fetch(`./data/${pack.file}`);
                const data = await res.json();
                const words = data.flatMap(t => t.words);

                // 3. Ghi vào sổ cái
                words.forEach(w => {
                    // Key là từ tiếng Anh (viết thường), Value là ID gói chứa nó
                    fullIndex[w.en.toLowerCase()] = pack.id;
                });
                console.log(`✅ Đã quét xong gói: ${pack.name}`);
            } catch (e) {
                console.error(`Lỗi quét gói ${pack.id}:`, e);
            }
        }

        // 4. Xuất file cho bạn tải về
        const blob = new Blob([JSON.stringify(fullIndex)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'search_index.json';
        a.click();

        console.log("🎉 XONG! File search_index.json đã được tải xuống.");
        console.log("👉 Hãy copy file này vào thư mục data/ của bạn.");
    },

    // --- TÍNH NĂNG ADMIN: DATABASE INSPECTOR ---

    openDatabaseInspector() {
        // 1. Tạo khung Modal Fullscreen
        const modalHTML = `
            <div id="db-inspector" class="modal-overlay show" style="justify-content:flex-start; align-items:flex-start; padding:0; background:var(--bg)">
                <div style="width:100%; height:100%; display:flex; flex-direction:column; background:var(--bg)">
                    
                    <div style="padding:15px; background:white; border-bottom:1px solid #E2E8F0; display:flex; justify-content:space-between; align-items:center; box-shadow:0 2px 5px rgba(0,0,0,0.05)">
                        <div>
                            <h3 style="margin:0; color:var(--text-main)"><i class="fa-solid fa-database"></i> Database View</h3>
                            <div style="font-size:0.8rem; color:var(--text-sub)">Đang tải: <b>${this.data.length}</b> bản ghi trong RAM</div>
                        </div>
                        <button onclick="document.getElementById('db-inspector').remove()" style="width:40px; height:40px; border-radius:12px; border:none; background:#F1F5F9; color:#64748B; font-size:1.2rem; cursor:pointer"><i class="fa-solid fa-xmark"></i></button>
                    </div>

                    <div style="padding:15px; display:flex; gap:10px; background:white;">
                        <input type="text" id="db-search" placeholder="🔍 Tìm ID, tiếng Anh, tiếng Việt..." onkeyup="App.renderDatabaseTable()" 
                            style="flex:1; padding:10px; border:1px solid #E2E8F0; border-radius:10px; font-size:0.95rem">
                        <button onclick="App.renderDatabaseTable()" style="padding:0 15px; background:var(--primary); color:white; border:none; border-radius:10px; cursor:pointer"><i class="fa-solid fa-rotate"></i></button>
                    </div>

                    <div style="flex:1; overflow-y:auto; padding:15px;">
                        <table class="db-table" style="width:100%; border-collapse:collapse; background:white; border-radius:10px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.05)">
                            <thead style="background:#F8FAFC; color:#64748B; font-size:0.8rem; text-transform:uppercase; text-align:left; position:sticky; top:0">
                                <tr>
                                    <th style="padding:12px;">ID</th>
                                    <th style="padding:12px;">Word (En)</th>
                                    <th style="padding:12px;">Meaning (Vi)</th>
                                    <th style="padding:12px;">Status</th>
                                    <th style="padding:12px; text-align:right">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="db-table-body"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.renderDatabaseTable();
    },

    renderDatabaseTable() {
        const query = document.getElementById('db-search')?.value.toLowerCase() || "";
        const tbody = document.getElementById('db-table-body');
        if (!tbody) return;

        // 1. Lọc dữ liệu
        const filtered = this.data.filter(w =>
            w.id.toLowerCase().includes(query) ||
            w.en.toLowerCase().includes(query) ||
            w.vi.toLowerCase().includes(query)
        );

        // 2. Render từng dòng (Giới hạn 100 dòng đầu để không lag)
        const html = filtered.slice(0, 100).map(w => {
            const stats = this.userProgress[w.id];
            const level = stats?.level || 0;

            // Màu sắc trạng thái
            let statusBadge = `<span style="padding:2px 6px; border-radius:4px; background:#F1F5F9; color:#94A3B8; font-size:0.75rem; font-weight:bold">New</span>`;
            if (level > 0) statusBadge = `<span style="padding:2px 6px; border-radius:4px; background:#ECFDF5; color:#10B981; font-size:0.75rem; font-weight:bold">Lvl ${level}</span>`;
            if (level >= 6) statusBadge = `<span style="padding:2px 6px; border-radius:4px; background:#F3E8FF; color:#8B5CF6; font-size:0.75rem; font-weight:bold">Master</span>`;

            return `
                <tr style="border-bottom:1px solid #F1F5F9; transition:0.2s" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background='white'">
                    <td style="padding:12px; font-family:monospace; color:#64748B; font-size:0.85rem">${w.id}</td>
                    <td style="padding:12px; font-weight:600; color:var(--text-main)">${w.en}</td>
                    <td style="padding:12px; color:var(--text-sub)">${w.vi}</td>
                    <td style="padding:12px;">${statusBadge}</td>
                    <td style="padding:12px; text-align:right">
                        <button onclick="App.adminResetWord('${w.id}')" title="Học lại từ đầu" style="padding:6px 10px; border:1px solid #E2E8F0; background:white; color:#F59E0B; border-radius:6px; cursor:pointer; margin-right:5px"><i class="fa-solid fa-rotate-left"></i></button>
                        <button onclick="App.adminDeleteWord('${w.id}')" title="Xóa tạm thời" style="padding:6px 10px; border:1px solid #E2E8F0; background:white; color:#EF4444; border-radius:6px; cursor:pointer"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `;
        }).join('');

        // 3. Hiển thị thông báo nếu trống
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:30px; text-align:center; color:#94A3B8">Không tìm thấy dữ liệu khớp lệnh "${query}"</td></tr>`;
        } else {
            tbody.innerHTML = html;
        }
    },

    

    // --- CÁC HÀM XỬ LÝ TRONG DATABASE VIEW ---
    adminResetWord(id) {
        if (confirm(`Bạn muốn reset tiến độ từ [${id}] về 0?`)) {
            // Xóa progress
            delete this.userProgress[id];
            this.saveProgress();
            this.showToast("Đã reset từ vựng!", "success");
            this.renderDatabaseTable(); // Vẽ lại bảng
        }
    },

    adminDeleteWord(id) {
        if (confirm(`⚠️ CẢNH BÁO: Bạn muốn xóa từ [${id}] khỏi bộ nhớ?\n(Lưu ý: Chỉ mất tạm thời, reload trang sẽ có lại vì file gốc không đổi)`)) {
            // Xóa khỏi mảng data trong RAM
            this.data = this.data.filter(w => w.id !== id);

            // Xóa khỏi progress luôn cho sạch
            delete this.userProgress[id];
            this.saveProgress();

            this.showToast("Đã xóa khỏi bộ nhớ đệm!", "info");
            this.renderDatabaseTable(); // Vẽ lại bảng
        }
    },

    

    // Hàm chuyển Tab
    switchDashTab(btn, tabId) {
        document.querySelectorAll('.dash-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.dash-content').forEach(c => c.style.display = 'none');
        
        btn.classList.add('active');
        document.getElementById(tabId).style.display = 'block';
    },

    // Hàm tải preview file Index
    async loadIndexPreview() {
        try {
            const res = await fetch('./data/search_index.json');
            if(res.ok) {
                const json = await res.json();
                const keys = Object.keys(json);
                
                document.getElementById('idx-count').innerText = keys.length;
                
                // Chỉ lấy 50 dòng đầu để hiển thị demo
                const preview = {};
                keys.slice(0, 50).forEach(k => preview[k] = json[k]);
                
                document.getElementById('idx-code').innerText = JSON.stringify(preview, null, 2) + "\n\n... (Còn " + (keys.length - 50) + " từ nữa)";
                document.getElementById('index-loading').style.display = 'none';
                document.getElementById('index-view').style.display = 'block';
            } else {
                document.getElementById('index-loading').innerHTML = '<span style="color:red">Chưa có file search_index.json. Hãy dùng công cụ tạo Index!</span>';
            }
        } catch(e) {
            document.getElementById('index-loading').innerText = "Lỗi đọc file: " + e.message;
        }
    },

    copyProgressToClip() {
        navigator.clipboard.writeText(JSON.stringify(this.userProgress, null, 2));
        this.showToast("Đã copy JSON vào bộ nhớ đệm!");
    },

    // --- TÍNH NĂNG: DATA DASHBOARD (GIAO DIỆN ĐẦY ĐỦ) ---
    openDataDashboard() {
        // HTML cho giao diện Dashboard
        const modalHTML = `
            <div id="data-dashboard" class="modal-overlay show" style="padding:0; background:var(--bg); align-items:flex-start">
                <div style="width:100%; height:100%; display:flex; flex-direction:column; background:#F8FAFC">
                    
                    <div style="padding:15px 20px; background:white; border-bottom:1px solid #E2E8F0; display:flex; justify-content:space-between; align-items:center; box-shadow: 0 2px 10px rgba(0,0,0,0.02)">
                        <div style="display:flex; align-items:center; gap:10px">
                            <div style="width:36px; height:36px; background:#6366F1; border-radius:8px; display:flex; align-items:center; justify-content:center; color:white"><i class="fa-solid fa-server"></i></div>
                            <div>
                                <h3 style="margin:0; color:#1E293B; font-size:1.1rem">Data Inspector</h3>
                                <div style="font-size:0.75rem; color:#64748B">System Management</div>
                            </div>
                        </div>
                        <button onclick="document.getElementById('data-dashboard').remove()" style="width:36px; height:36px; border:none; background:#F1F5F9; border-radius:8px; font-size:1.1rem; cursor:pointer; color:#64748B"><i class="fa-solid fa-xmark"></i></button>
                    </div>

                    <div style="background:white; border-bottom:1px solid #E2E8F0; padding:10px 20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
                        <button class="dash-tab active" onclick="App.switchDashTab(this, 'tab-db')"><i class="fa-solid fa-table"></i> Database</button>
                        <button class="dash-tab" onclick="App.switchDashTab(this, 'tab-files')"><i class="fa-regular fa-folder-open"></i> Files</button>
                        
                        <div style="margin-left:auto;">
                            <input type="file" id="csv-upload" accept=".csv" style="display:none" onchange="App.handleCsvToStructure(this)">
                            <button onclick="document.getElementById('csv-upload').click()" style="background:#6366F1; color:white; border:none; padding:8px 15px; border-radius:8px; cursor:pointer; font-weight:700; display:flex; align-items:center; gap:8px; box-shadow:0 2px 5px rgba(99, 102, 241, 0.3)">
                                <i class="fa-solid fa-file-csv"></i> Import CSV & Build Data
                            </button>
                        </div>
                    </div>

                    <div style="flex:1; overflow:hidden; position:relative">
                        
                        <div id="tab-db" class="dash-content" style="height:100%; display:flex; flex-direction:column;">
                            <div style="padding:15px 20px; background:#F8FAFC; border-bottom:1px solid #E2E8F0;">
                                <input type="text" id="db-search-input" placeholder="Tìm kiếm trong RAM..." onkeyup="App.renderDatabaseGrid()" 
                                    style="width:100%; padding:10px; border:1px solid #CBD5E1; border-radius:8px;">
                            </div>
                            <div id="db-grid-body" style="flex:1; overflow-y:auto; background:white; padding:10px;">
                                </div>
                        </div>

                        <div id="tab-files" class="dash-content" style="display:none; padding:20px; overflow-y:auto; height:100%">
                            <div class="dash-card" style="background:white; padding:15px; border-radius:12px; border:1px solid #E2E8F0">
                                <h4><i class="fa-solid fa-network-wired"></i> Cấu trúc Gói (Packs)</h4>
                                <table class="db-table" style="width:100%; margin-top:10px; border-collapse:collapse">
                                    <thead style="background:#F1F5F9; color:#64748B; font-size:0.75rem">
                                        <tr><th style="padding:10px">ID</th><th>Name</th><th>Path</th><th style="text-align:right">Size</th></tr>
                                    </thead>
                                    <tbody>
                                        ${this.packList.map(p => `
                                            <tr style="border-bottom:1px solid #F1F5F9">
                                                <td style="padding:10px; font-family:monospace; color:#6366F1">${p.id}</td>
                                                <td><b>${p.name}</b></td>
                                                <td style="color:#64748B">/data/${p.file}</td>
                                                <td style="text-align:right">${p.count || '?'} từ</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.renderDatabaseGrid(); // Render dữ liệu ban đầu
    },

    // --- LOGIC RENDER DATABASE GRID (TỰ ĐỘNG) ---
    renderDatabaseGrid() {
        const query = document.getElementById('db-search-input')?.value.toLowerCase() || "";
        const filter = document.getElementById('db-filter-level')?.value || "all";
        const container = document.getElementById('db-grid-body');
        
        if (!container) return;

        // 1. Lọc dữ liệu
        let list = this.data.filter(w => 
            w.id.toLowerCase().includes(query) || 
            w.en.toLowerCase().includes(query) || 
            w.vi.toLowerCase().includes(query)
        );

        if (filter === 'learned') list = list.filter(w => (this.userProgress[w.id]?.level || 0) > 0);
        if (filter === 'master') list = list.filter(w => (this.userProgress[w.id]?.level || 0) >= 6);

        // 2. Render từng dòng (Grid Row)
        const html = list.slice(0, 200).map(w => { // Limit 200 dòng để tránh lag
            const stats = this.userProgress[w.id] || {};
            const level = stats.level || 0;
            const streak = stats.streak || 0;
            
            // Format ngày ôn
            let nextReview = "-";
            if (stats.nextReview) {
                const date = new Date(stats.nextReview);
                nextReview = date.toLocaleString('vi-VN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                if (Date.now() > stats.nextReview) nextReview = `<span style="color:#EF4444; font-weight:bold">Overdue</span>`;
            }

            // Màu Level
            let lvlBadge = `<span style="background:#F1F5F9; color:#94A3B8; padding:2px 6px; border-radius:4px; font-size:0.7rem">New</span>`;
            if (level > 0) lvlBadge = `<span style="background:#ECFDF5; color:#059669; padding:2px 6px; border-radius:4px; font-size:0.7rem; font-weight:bold">Lvl ${level}</span>`;
            if (level >= 6) lvlBadge = `<span style="background:#F3E8FF; color:#7C3AED; padding:2px 6px; border-radius:4px; font-size:0.7rem; font-weight:bold">Max</span>`;

            return `
                <div style="display:grid; grid-template-columns: 80px 1fr 1fr 80px 100px 150px; border-bottom:1px solid #F1F5F9; padding:12px 20px; font-size:0.85rem; align-items:center; hover:bg-slate-50">
                    <div style="font-family:monospace; color:#64748B; font-size:0.75rem">${w.id}</div>
                    <div style="font-weight:600; color:#1E293B">${w.en}</div>
                    <div style="color:#475569">${w.vi}</div>
                    <div>${lvlBadge}</div>
                    <div style="font-family:monospace">🔥 ${streak}</div>
                    <div style="font-size:0.75rem; color:#64748B">${nextReview}</div>
                </div>
            `;
        }).join('');

        container.innerHTML = html || `<div style="padding:40px; text-align:center; color:#94A3B8">Không tìm thấy dữ liệu</div>`;
        document.getElementById('db-status-count').innerText = `Hiển thị: ${Math.min(list.length, 200)} / ${list.length} bản ghi`;
    },

    switchDashTab(btn, tabId) {
        document.querySelectorAll('.dash-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.dash-content').forEach(c => c.style.display = 'none');
        btn.classList.add('active');
        document.getElementById(tabId).style.display = (tabId === 'tab-db') ? 'flex' : 'block';
    },

    // --- HÀM XEM CHI TIẾT GÓI (DRILL-DOWN) ---
    async inspectPackDetail(filename, packName) {
        const view = document.getElementById('inspector-detail-view');
        if(!view) return;

        // 1. Hiển thị màn hình loading
        view.style.display = 'flex';
        view.innerHTML = `
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#64748B">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:2rem; margin-bottom:15px; color:#6366F1"></i>
                <div>Đang đọc file <b>${filename}</b>...</div>
            </div>
        `;

        try {
            // 2. Tải file JSON thực tế
            const res = await fetch(`./data/${filename}?v=${Date.now()}`);
            if(!res.ok) throw new Error("Không thể đọc file data");
            const rawData = await res.json();
            
            // 3. Gom tất cả từ vựng lại (Flatten)
            const allWords = rawData.flatMap(topic => topic.words);

            // 4. Render Bảng chi tiết
            view.innerHTML = `
                <div style="padding:15px 20px; background:white; border-bottom:1px solid #E2E8F0; display:flex; align-items:center; gap:15px">
                    <button onclick="document.getElementById('inspector-detail-view').style.display='none'" style="width:36px; height:36px; border:1px solid #E2E8F0; background:white; border-radius:8px; cursor:pointer; color:#64748B">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <div>
                        <h3 style="margin:0; color:#1E293B; font-size:1rem">${packName}</h3>
                        <div style="font-size:0.75rem; color:#64748B">File: ${filename} • Số lượng: <b>${allWords.length}</b> từ</div>
                    </div>
                    <div style="margin-left:auto">
                        <button onclick="App.copyJsonToClip('${filename}')" title="Copy JSON" style="padding:8px 12px; border:1px solid #E2E8F0; background:#F8FAFC; border-radius:6px; cursor:pointer; font-size:0.8rem"><i class="fa-regular fa-copy"></i> Copy Raw</button>
                    </div>
                </div>

                <div style="flex:1; overflow-y:auto; padding:20px">
                    <div class="dash-card" style="border:1px solid #E2E8F0; border-radius:12px; overflow:hidden">
                        <table class="db-table" style="width:100%; border-collapse: collapse;">
                            <thead style="background:#F1F5F9; color:#475569; font-size:0.75rem; text-transform:uppercase; border-bottom:1px solid #E2E8F0">
                                <tr>
                                    <th style="padding:12px; text-align:left; width:50px">#</th>
                                    <th style="padding:12px; text-align:left">English</th>
                                    <th style="padding:12px; text-align:left">Tiếng Việt</th>
                                    <th style="padding:12px; text-align:left">Loại</th>
                                    <th style="padding:12px; text-align:left">Ví dụ</th>
                                </tr>
                            </thead>
                            <tbody style="background:white">
                                ${allWords.map((w, index) => `
                                    <tr style="border-bottom:1px solid #F1F5F9; font-size:0.9rem">
                                        <td style="padding:12px; color:#94A3B8; font-size:0.8rem">${index + 1}</td>
                                        <td style="padding:12px;">
                                            <div style="font-weight:600; color:#1E293B">${w.en}</div>
                                            <div style="font-size:0.75rem; color:#6366F1; font-family:monospace">${w.id}</div>
                                        </td>
                                        <td style="padding:12px; color:#334155">${w.vi}</td>
                                        <td style="padding:12px;">
                                            <span style="background:#F1F5F9; color:#64748B; padding:2px 6px; border-radius:4px; font-size:0.75rem; font-weight:bold">${w.type || 'n/a'}</span>
                                        </td>
                                        <td style="padding:12px; color:#64748B; font-style:italic; font-size:0.85rem">"${w.example || ''}"</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    
                    <textarea id="hidden-json-${filename}" style="display:none">${JSON.stringify(rawData, null, 2)}</textarea>
                </div>
            `;

        } catch (e) {
            view.innerHTML = `
                <div style="padding:20px; color:#EF4444; text-align:center">
                    <i class="fa-solid fa-circle-exclamation" style="font-size:2rem; margin-bottom:10px"></i>
                    <div>Không đọc được file: ${filename}</div>
                    <div style="font-size:0.8rem; margin-top:5px">${e.message}</div>
                    <button onclick="document.getElementById('inspector-detail-view').style.display='none'" style="margin-top:20px; padding:8px 16px; cursor:pointer">Quay lại</button>
                </div>
            `;
        }
    },

    copyJsonToClip(filename) {
        const text = document.getElementById(`hidden-json-${filename}`).value;
        navigator.clipboard.writeText(text);
        this.showToast("Đã copy toàn bộ JSON vào bộ nhớ đệm!", "success");
    },

    // --- TÍNH NĂNG: MỞ WEB LUYỆN NÓI ---
    openSpeakingTool() {
        // Link web luyện nói bạn muốn (Free4Talk, Elsa, v.v...)
        const targetUrl = "https://english-speaking-app.pages.dev/"; 
        
        if(confirm("Bạn có muốn mở trang web luyện nói do Tiến Rose phát triển không")) {
            window.open(targetUrl, '_blank');
        }
    },

    // --- IMPORT CSV & BUILD DATA ---
    handleCsvToStructure(input) {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];

        // Check thư viện
        if (typeof Papa === 'undefined' || typeof JSZip === 'undefined') {
            alert("LỖI: Chưa chèn thư viện PapaParse hoặc JSZip vào index.html!");
            return;
        }

        this.showToast("⏳ Đang xử lý CSV...", "info");

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                this.buildScalableData(results.data);
            },
            error: (err) => {
                alert("Lỗi đọc file CSV: " + err.message);
            }
        });
    },

    async buildScalableData(rows) {
        try {
            const zip = new JSZip();
            const topicsIndex = [];
            const struct = {}; 

            // 1. Phân loại
            rows.forEach(row => {
                const r = {};
                Object.keys(row).forEach(k => r[k.trim().toLowerCase()] = row[k]);

                const level = (r['level'] || 'General').trim(); 
                const topic = (r['topic'] || 'Common').trim();

                if (!struct[level]) struct[level] = {};
                if (!struct[level][topic]) struct[level][topic] = [];

                struct[level][topic].push({
                    id: r['id'] || Math.random().toString(36).substr(2, 6),
                    en: r['word'] || r['english'] || '',
                    vi: r['meaning_vi'] || r['vietnamese'] || '',
                    type: r['pos'] || '',
                    ipa: r['ipa'] || '',
                    example: r['example_en'] || ''
                });
            });

            // 2. Tạo Zip
            let count = 0;
            for (const [lvl, topics] of Object.entries(struct)) {
                const dirName = lvl.toLowerCase().replace(/[^a-z0-9]/g, '');
                const folder = zip.folder(dirName);

                for (const [topicName, words] of Object.entries(topics)) {
                    const fileName = topicName.toLowerCase().replace(/[^a-z0-9]/g, '_') + ".json";
                    const content = [{ id: `topic_${fileName}`, name: topicName, icon: "fa-book", words: words }];
                    
                    folder.file(fileName, JSON.stringify(content, null, 2));

                    topicsIndex.push({
                        id: `pack_${fileName.replace('.json','')}`,
                        name: topicName,
                        desc: `Chủ đề ${topicName} (${lvl})`,
                        level: lvl.toUpperCase(),
                        file: `${dirName}/${fileName}`,
                        count: words.length,
                        icon: "fa-folder",
                        color: "#4F46E5"
                    });
                    count++;
                }
            }

            topicsIndex.sort((a, b) => a.level.localeCompare(b.level));
            zip.file("topics_index.json", JSON.stringify(topicsIndex, null, 2));

            const content = await zip.generateAsync({ type: "blob" });
            saveAs(content, "data_optimized.zip");
            
            this.showToast(`✅ Đã xong! ${count} gói.`, "success");

        } catch (e) {
            alert("Lỗi xử lý: " + e.message);
        }
    },
    

};

document.addEventListener('DOMContentLoaded', () => App.init());