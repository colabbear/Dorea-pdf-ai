/* =====================================================
   RAG Sources Manager - 출처 패널 관리 시스템
   ===================================================== */

class RagSourcesManager {
    constructor() {
        this.activePanel = null;
        this.savedScrollPositions = new Map();
        this.typeMap = {
            'text': { icon: '📄', name: '텍스트', color: '#64748b' },
            'Text': { icon: '📄', name: '텍스트', color: '#64748b' },
            'Picture': { icon: '🖼️', name: '이미지', color: '#8b5cf6' },
            'Figure': { icon: '📊', name: '도표', color: '#06b6d4' },
            'Table': { icon: '📋', name: '표', color: '#10b981' },
            'Title': { icon: '📌', name: '제목', color: '#f59e0b' },
            'Caption': { icon: '💬', name: '캡션', color: '#6366f1' },
            'Page header': { icon: '🔝', name: '머리글', color: '#84cc16' },
            'Page footer': { icon: '🔻', name: '바닥글', color: '#ef4444' }
        };
        
        this.initializeEventListeners();
    }

    // 이벤트 리스너 초기화
    initializeEventListeners() {
        // 전역 클릭 이벤트로 패널 외부 클릭 시 닫기
        document.addEventListener('click', (event) => {
            if (!event.target.closest('.rag-sources-container')) {
                this.closeAllPanels();
            }
        });

        // ESC 키로 패널 닫기
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeAllPanels();
            }
        });
    }

    // 출처 버튼 HTML 생성 (버튼만)
    createSourcesButton(similarDocs) {
        if (!similarDocs || similarDocs.length === 0) return '';
        
        const sourcesData = this.processSourcesData(similarDocs);
        const sourcesId = `rag-sources-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        return `
            <div class="rag-sources-container" data-sources-id="${sourcesId}">
                <button class="rag-sources-toggle-btn" data-sources-id="${sourcesId}">
                    <span class="rag-sources-icon">🔗</span>
                    <span class="rag-sources-text">출처 ${similarDocs.length}개</span>
                    <span class="rag-sources-arrow">▼</span>
                </button>
            </div>
        `;
    }

    // 패널 HTML 생성 (별도 메서드)
    createPanelElement(sourcesId) {
        return `<div class="rag-sources-panel" data-sources-id="${sourcesId}" style="display: none;"></div>`;
    }

    // 소스 데이터 처리 (public 메서드)
    processSourcesData(similarDocs) {
        return similarDocs.map(doc => {
            console.log('🔍 RAG 문서 메타데이터:', doc.metadata);
            return {
                pageNum: doc.metadata?.page_number || doc.page_number || doc.page || '?',
                pageNums: doc.metadata?.page_numbers || `[${doc.metadata?.page_number || doc.page_number || doc.page || '?'}]`,
                docType: doc.metadata?.segment_type || doc.type || 'Text',
                similarity: doc.distance !== undefined ? Math.abs(((1 - doc.distance) * 100)).toFixed(1) : '?',
                preview: doc.text ? doc.text.substring(0, 80) + '...' : '내용 없음',
                segmentId: doc.metadata?.segment_id || doc.segment_id || null,
                chunkIndex: doc.metadata?.chunk_index || null,
                subChunk: doc.metadata?.sub_chunk || null,
                fullText: doc.text || '',
                allMetadata: doc.metadata || {} // 디버깅용
            };
        });
    }

    // 패널 토글
    togglePanel(buttonElement, sourcesData) {
        const sourcesId = buttonElement.dataset.sourcesId;
        const chatMessage = buttonElement.closest('.chat-message');
        const panel = chatMessage ? chatMessage.querySelector(`[data-sources-id="${sourcesId}"].rag-sources-panel`) : null;
        const arrow = buttonElement.querySelector('.rag-sources-arrow');
        
        if (!panel) return;

        const isVisible = panel.classList.contains('show');
        
        if (isVisible) {
            this.closePanel(buttonElement, panel, arrow);
        } else {
            this.closeAllPanels();
            this.openPanel(buttonElement, panel, arrow, sourcesData);
        }
    }

    // 패널 열기
    openPanel(button, panel, arrow, sourcesData) {
        // 스크롤 위치 저장
        const chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
            this.savedScrollPositions.set(button.dataset.sourcesId, chatContainer.scrollTop);
        }

        // 패널 내용 생성
        panel.innerHTML = this.createPanelContent(sourcesData);
        
        // 패널 표시
        panel.style.display = 'block';
        
        // 애니메이션을 위한 지연
        requestAnimationFrame(() => {
            panel.classList.add('show');
            button.classList.add('active');
            arrow.textContent = '▲';
            
            // 카드 클릭 이벤트 등록
            this.attachCardEvents(panel, sourcesData);
            
            // 위치 조정 (CSS absolute positioning으로 처리됨)
            // this.adjustPanelPosition(button, panel);
            
            // 패널이 보이도록 자동 스크롤
            this.scrollToPanel(panel);
        });

        this.activePanel = { button, panel, arrow };
    }

    // 패널 닫기
    closePanel(button, panel, arrow) {
        panel.classList.remove('show');
        button.classList.remove('active');
        arrow.textContent = '▼';
        
        // 애니메이션 완료 후 숨기기
        setTimeout(() => {
            panel.style.display = 'none';
        }, 200);

        // 스크롤 위치 복원
        const chatContainer = document.getElementById('chatContainer');
        const savedScrollTop = this.savedScrollPositions.get(button.dataset.sourcesId);
        if (chatContainer && savedScrollTop !== undefined) {
            chatContainer.scrollTop = savedScrollTop;
            this.savedScrollPositions.delete(button.dataset.sourcesId);
        }

        if (this.activePanel?.button === button) {
            this.activePanel = null;
        }
    }

    // 모든 패널 닫기
    closeAllPanels() {
        document.querySelectorAll('.rag-sources-panel.show').forEach(panel => {
            const sourcesId = panel.dataset.sourcesId;
            const button = document.querySelector(`[data-sources-id="${sourcesId}"].rag-sources-toggle-btn`);
            const arrow = button?.querySelector('.rag-sources-arrow');
            
            if (button && arrow) {
                this.closePanel(button, panel, arrow);
            }
        });
    }

    // 패널 콘텐츠 생성
    createPanelContent(sourcesData) {
        return `
            <div class="rag-panel-header">
                <h4>📚 참조 출처</h4>
                <span class="rag-sources-count">${sourcesData.length}개</span>
            </div>
            <div class="rag-sources-list">
                ${sourcesData.map((doc, index) => this.createSourceCard(doc, index)).join('')}
            </div>
        `;
    }

    // 개별 출처 카드 생성
    createSourceCard(doc, index) {
        const typeInfo = this.typeMap[doc.docType] || { 
            icon: '📄', 
            name: doc.docType || '텍스트', 
            color: '#64748b' 
        };
        
        return `
            <div class="rag-sources-card" 
                 data-page="${doc.pageNum}" 
                 data-segment-id="${doc.segmentId || ''}"
                 data-index="${index}"
                 style="--type-color: ${typeInfo.color}">
                <div class="rag-card-header">
                    <div class="rag-sources-type">
                        <span class="rag-sources-emoji">${typeInfo.icon}</span>
                        <span class="rag-sources-type-name">${typeInfo.name}</span>
                    </div>
                    <div class="rag-sources-meta">
                        <span class="rag-sources-page">${doc.pageNum}p</span>
                        <span class="rag-sources-similarity">${doc.similarity}%</span>
                    </div>
                </div>
                <div class="rag-sources-content">${doc.preview}</div>
            </div>
        `;
    }

    // 카드 클릭 이벤트 등록
    attachCardEvents(panel, sourcesData) {
        const cards = panel.querySelectorAll('.rag-sources-card');
        
        cards.forEach((card, index) => {
            card.addEventListener('click', (event) => {
                event.stopPropagation();
                
                const pageNum = card.dataset.page;
                const segmentId = card.dataset.segmentId;
                
                if (pageNum !== '?') {
                    this.handleCardClick(pageNum, segmentId, sourcesData[index]);
                    this.closeAllPanels();
                }
            });

            // 호버 효과 개선
            card.addEventListener('mouseenter', () => {
                card.style.transform = 'translateX(4px)';
            });

            card.addEventListener('mouseleave', () => {
                card.style.transform = 'translateX(0)';
            });
        });
    }

    // 카드 클릭 처리
    handleCardClick(pageNum, segmentId, sourceData) {
        console.log('출처 카드 클릭:', { pageNum, segmentId, sourceData });
        
        // PDF 페이지 이동
        if (window.pdfViewer && window.pdfViewer.goToPage) {
            const success = window.pdfViewer.goToPage(parseInt(pageNum));
            
            if (success) {
                // 페이지 이동 후 세그먼트 하이라이팅
                setTimeout(() => {
                    if (window.pdfViewer.highlightSegmentText) {
                        console.log('🔍 하이라이팅 시도:', {
                            pageNum: pageNum,
                            docType: sourceData.docType,
                            preview: sourceData.preview?.substring(0, 30)
                        });
                        
                        const highlighted = window.pdfViewer.highlightSegmentText(sourceData, parseInt(pageNum));
                        
                        if (highlighted) {
                            console.log(`✅ 세그먼트 하이라이팅 성공`);
                            
                            // 성공 알림
                            if (window.showNotification) {
                                window.showNotification(`페이지 ${pageNum}로 이동하고 세그먼트를 하이라이팅했습니다.`, 'success');
                            }
                        } else {
                            console.warn('⚠️ 세그먼트를 찾을 수 없어 하이라이팅하지 못했습니다.');
                            
                            // 페이지 이동만 알림
                            if (window.showNotification) {
                                window.showNotification(`페이지 ${pageNum}로 이동했습니다.`, 'success');
                            }
                        }
                    } else {
                        console.log('🔍 하이라이팅 함수를 찾을 수 없음');
                        
                        // 하이라이팅 없이 페이지 이동만
                        if (window.showNotification) {
                            window.showNotification(`페이지 ${pageNum}로 이동했습니다.`, 'success');
                        }
                    }
                }, 1000); // PDF 페이지 렌더링을 기다림
            }
        } else {
            console.warn('PDF 뷰어를 찾을 수 없습니다.');
        }

        // 커스텀 이벤트 발생
        document.dispatchEvent(new CustomEvent('ragSourceClicked', {
            detail: { pageNum, segmentId, sourceData }
        }));
    }

    // 패널이 보이도록 자동 스크롤
    scrollToPanel(panel) {
        setTimeout(() => {
            const chatContainer = document.getElementById('chatContainer');
            if (chatContainer && panel) {
                const panelRect = panel.getBoundingClientRect();
                const containerRect = chatContainer.getBoundingClientRect();
                
                // 패널 하단이 화면 밖에 있으면 스크롤
                if (panelRect.bottom > containerRect.bottom) {
                    const scrollOffset = panelRect.bottom - containerRect.bottom + 20; // 20px 여유공간
                    chatContainer.scrollTop += scrollOffset;
                }
            }
        }, 100); // 애니메이션 완료 후 실행
    }

    // 패널 위치 조정 (디버깅용 - 일단 비활성화)
    adjustPanelPosition(button, panel) {
        console.log('adjustPanelPosition called');
        console.log('Button rect:', button.getBoundingClientRect());
        console.log('Panel rect:', panel.getBoundingClientRect());
        console.log('Viewport:', { width: window.innerWidth, height: window.innerHeight });
        
        // 일단 JavaScript 위치 조정 비활성화, CSS만 사용
        // setTimeout(() => {
        //     // 위치 조정 로직 비활성화
        // }, 100);
    }

    // 외부에서 호출할 수 있는 초기화 메서드
    initialize(container, sourcesData) {
        const button = container.querySelector('.rag-sources-toggle-btn');
        if (button) {
            const sourcesId = button.dataset.sourcesId;
            
            // chat-message 레벨 찾기
            const chatMessage = container.closest('.chat-message');
            if (chatMessage) {
                // 기존 패널 제거 (있다면)
                const existingPanel = chatMessage.querySelector(`[data-sources-id="${sourcesId}"].rag-sources-panel`);
                if (existingPanel) {
                    existingPanel.remove();
                }
                
                // 새로운 패널을 chat-message에 추가
                chatMessage.insertAdjacentHTML('beforeend', this.createPanelElement(sourcesId));
            }
            
            // 기존 이벤트 리스너 제거
            button.replaceWith(button.cloneNode(true));
            const newButton = container.querySelector('.rag-sources-toggle-btn');
            
            // 새로운 이벤트 리스너 등록
            newButton.addEventListener('click', (event) => {
                event.stopPropagation();
                this.togglePanel(newButton, sourcesData);
            });
        }
    }
}

// 애니메이션 CSS 추가
const style = document.createElement('style');
style.textContent = `
    @keyframes ragPanelSlideIn {
        from {
            opacity: 0;
            transform: translateY(-8px) scale(0.98);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
`;
document.head.appendChild(style);

// 전역 인스턴스 생성
window.ragSourcesManager = new RagSourcesManager();

export default RagSourcesManager;