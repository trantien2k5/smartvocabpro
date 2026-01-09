// --- FILE: js/algorithm.js ---
const MemoryEngine = {
    // Cấu hình các cấp độ (Tính bằng giờ)
    intervals: {
        0: 0,       // New: Học ngay
        1: 4,       // Step 1: 4 tiếng sau ôn lại
        2: 24,      // Step 2: 1 ngày
        3: 72,      // Step 3: 3 ngày
        4: 168,     // Step 4: 1 tuần
        5: 336,     // Step 5: 2 tuần
        6: 720      // Master: 1 tháng
    },

    // Hàm tính toán trạng thái tiếp theo
    processResult(currentStats, isCorrect) {
        // Tạo bản sao để không sửa trực tiếp data gốc
        let stats = currentStats ? { ...currentStats } : { 
            level: 0, 
            streak: 0, 
            lastReview: Date.now(),
            ease: 2.5 // Độ dễ (Mặc định 2.5, càng cao càng dễ)
        };

        const now = Date.now();

        if (isCorrect) {
            // NẾU TRẢ LỜI ĐÚNG
            if (stats.level < 6) {
                stats.level++; 
            }
            stats.streak++;
            
            // Logic thưởng: Nếu trả lời đúng liên tục, giãn thời gian ôn ra xa hơn (Bonus Ease)
            if (stats.streak > 2) stats.ease += 0.1;

        } else {
            // NẾU TRẢ LỜI SAI
            // Phạt nặng: Rớt cấp độ thê thảm
            stats.level = stats.level > 3 ? 3 : 1; 
            stats.streak = 0;
            stats.ease = Math.max(1.3, stats.ease - 0.2); // Giảm độ dễ => Lần sau gặp nhiều hơn
        }

        // Tính thời gian ôn tiếp theo (Next Review)
        // Công thức: Giờ * Ease Factor * 60 phút * 60 giây * 1000 mili giây
        const hoursToAdd = this.intervals[stats.level] * stats.ease;
        stats.nextReview = now + (hoursToAdd * 60 * 60 * 1000);
        stats.lastReview = now;

        return stats;
    },

    // Hàm kiểm tra "Sức khỏe" từ vựng (0 - 100%)
    getHealth(stats) {
        if (!stats || !stats.nextReview) return 0;
        const now = Date.now();
        const totalTime = stats.nextReview - stats.lastReview;
        const elapsedTime = now - stats.lastReview;
        
        // Nếu chưa đến giờ ôn => Sức khỏe còn (từ 100% giảm dần về 0%)
        if (now < stats.nextReview) {
            const health = 100 - (elapsedTime / totalTime * 100);
            return Math.max(0, Math.round(health));
        }
        // Nếu quá giờ ôn => Sức khỏe âm (Cần cấp cứu)
        return 0;
    }
};