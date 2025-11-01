// knowledgeManager.js - 지식 관리 및 임베딩 관리 모듈

import { showNotification } from './utils.js';

class KnowledgeManager {
    constructor() {
        this.currentView = 'chat'; // 'chat' or 'knowledge'
        this.selectedItem = null;
        this.embeddingData = new Map(); // 파일별 임베딩 상태 캐시
        this.treeData = null; // 파일 트리 데이터 캐시
        this.pollingInterval = null; // 진행률 체크용 polling
        this.embeddingDownloadController = null; // 임베딩 모델 다운로드 중단용
        this.expandedFolders = new Set(); // 확장된 폴더 추적
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadEmbeddingData();
    }

    setupEventListeners() {
        // 페이지 전환 이벤트 리스너는 main에서 설정
    }

    // 지식 관리 페이지 전용 이벤트 리스너 설정
    setupKnowledgeEventListeners() {
        const container = document.getElementById('knowledgeContainer');
        if (!container) return;

        // 이벤트 리스너가 중복 등록되는 것을 방지
        if (this.knowledgeEventListenersAttached) {
            return;
        }

        container.addEventListener('click', (e) => {
            const target = e.target;

            // 모델 선택 옵션 클릭
            const modelOption = target.closest('.model-option');
            if (modelOption) {
                this.selectEmbeddingModel(modelOption);
                return;
            }

            // 모델 테스트 버튼 클릭
            const testBtn = target.closest('.test-model-btn');
            if (testBtn) {
                const action = testBtn.dataset.action;
                if (action === 'test-ollama-model') {
                    this.testOllamaEmbeddingModel();
                } else if (action === 'test-openai-model') {
                    this.testOpenaiEmbeddingModel();
                }
                return;
            }
        });
        
        this.knowledgeEventListenersAttached = true;
    }


    // 지식 관리 페이지 표시
    async showKnowledgeView() {
        const container = document.getElementById('knowledgeContainer');
        if (!container) return;

        // HTML은 이미 index.html에 있으므로 그냥 표시만 함
        container.style.display = 'grid';

        // 폴더 트리 데이터 로드 및 렌더링
        await this.loadFolderTreeWithEmbedding();

        // 통계 업데이트
        this.updateEmbeddingStats();
        
        // 이벤트 리스너 설정
        this.setupKnowledgeEventListeners();
    }

    // 지식 관리 페이지 숨기기
    hideKnowledgeView() {
        const container = document.getElementById('knowledgeContainer');
        if (container) {
            container.style.display = 'none';
        }
    }

    // CSS 스타일 동적 로드
    async loadKnowledgeStyles() {
        // CSS가 이미 로드되었는지 확인
        if (document.querySelector('link[href*="knowledge.css"]')) {
            return;
        }

        return new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/static/css/knowledge.css';
            link.onload = resolve;
            link.onerror = reject;
            document.head.appendChild(link);
        });
    }

    // 폴더 트리 데이터 로드 (임베딩 상태 포함)
    async loadFolderTreeWithEmbedding() {
        try {
            // 기존 folderTreeManager의 데이터 활용
            if (window.folderTreeManager && window.folderTreeManager.getCurrentTree) {
                const treeData = window.folderTreeManager.getCurrentTree();
                await this.renderKnowledgeTree(treeData);
            } else {
                // 폴더 트리 매니저가 없으면 API 직접 호출
                await this.loadFolderTreeFromAPI();
            }
        } catch (error) {
            console.error('폴더 트리 로드 실패:', error);
            showNotification('폴더 트리를 불러오는데 실패했습니다.', 'error');
        }
    }

    // API에서 폴더 트리 직접 로드
    async loadFolderTreeFromAPI() {
        const token = localStorage.getItem('token');
        if (!token) return;

        const response = await fetch('/api/folders', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
            await this.renderKnowledgeTree(data.data || []);
        }
    }

    // 임베딩 상태와 함께 트리 렌더링
    async renderKnowledgeTree(treeData) {
        const container = document.getElementById('knowledgeFolderTree');
        if (!container) return;

        // 임베딩 상태 정보 가져오기
        await this.loadEmbeddingStates(treeData);

        const html = this.generateTreeHTML(treeData);
        container.innerHTML = html;
    }

    // 트리 HTML 생성 (임베딩 상태 포함)
    generateTreeHTML(items, level = 0) {
        let html = '';
        
        items.forEach(item => {
            const embeddingStatus = this.getEmbeddingStatus(item);
            const indent = level * 20;
            
            if (item.type === 'folder') {
                const folderStats = this.getFolderEmbeddingStats(item);
                html += `
                    <div class="tree-item" style="margin-left: ${indent}px;">
                        <div class="tree-node folder" data-type="folder" data-id="${item.id}">
                            <div class="node-icon">📁</div>
                            <div class="node-content">
                                <span class="node-name">${item.name}</span>
                                <span class="folder-summary">(${folderStats.completed}/${folderStats.total})</span>
                                <div class="embedding-indicator ${folderStats.status}"></div>
                            </div>
                        </div>
                `;
                
                // 하위 항목들을 folder-children div로 감싸기 (tree-item 안에)
                if (item.children && item.children.length > 0) {
                    html += `<div class="folder-children">
`;
                    html += this.generateTreeHTML(item.children, level + 1);
                    html += `</div>`;
                }
                html += `</div>`;
                if (item.files && item.files.length > 0) {
                    html += this.generateTreeHTML(item.files, level + 1);
                }
            } else {
                // 파일
                html += `
                    <div class="tree-item" style="margin-left: ${indent}px;">
                        <div class="tree-node file" data-type="file" data-id="${item.id}">
                            <div class="node-icon">📄</div>
                            <div class="node-content">
                                <span class="node-name">${item.filename}</span>
                                <div class="embedding-indicator ${embeddingStatus}"></div>
                            </div>
                        </div>
                    </div>
                `;
            }
        });
        
        return html;
    }

    // 파일의 임베딩 상태 가져오기
    getEmbeddingStatus(item) {
        if (item.type !== 'file') return 'none';
        
        const embeddingData = this.embeddingData.get(item.id);
        if (!embeddingData) return 'none';
        
        return embeddingData.status || 'none';
    }

    // 폴더의 임베딩 통계
    getFolderEmbeddingStats(folder) {
        let total = 0;
        let completed = 0;
        let processing = 0;
        
        const countFiles = (items) => {
            items.forEach(item => {
                if (item.type === 'file') {
                    total++;
                    const status = this.getEmbeddingStatus(item);
                    if (status === 'completed') completed++;
                    else if (status === 'processing') processing++;
                } else if (item.children) {
                    countFiles(item.children);
                }
                if (item.files) {
                    countFiles(item.files);
                }
            });
        };
        
        if (folder.children) countFiles(folder.children);
        if (folder.files) countFiles(folder.files);
        
        return {
            total,
            completed,
            processing,
            status: processing > 0 ? 'processing' : completed === total ? 'completed' : 'none'
        };
    }

    // 임베딩 상태 데이터 로드
    async loadEmbeddingStates(treeData) {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch('/api/knowledge/embeddings', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                // 파일별 임베딩 상태를 Map에 저장
                data.embeddings?.forEach(embedding => {
                    this.embeddingData.set(embedding.file_id, embedding);
                });
            }
        } catch (error) {
            console.error('임베딩 상태 로드 실패:', error);
        }
    }

    // 임베딩 데이터 로드
    async loadEmbeddingData() {
        // 먼저 설정을 확인하고 설정이 있을 때만 다른 데이터 로드
        const settingsLoaded = await this.loadEmbeddingSettings();
        if (settingsLoaded) {
            await this.loadFolderTreeWithEmbedding();
        } else {
            // 설정이 없으면 폴더 트리만 로드 (임베딩 상태 없이)
            await this.loadFolderTreeOnly();
        }
    }

    // 폴더 트리와 임베딩 상태 동시 로드
    async loadFolderTreeWithEmbedding() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            // 파일 트리 데이터 로드
            const treeResponse = await fetch('/api/folders', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (treeResponse.ok) {
                const response = await treeResponse.json();
                console.log('API Response:', response); // 디버깅용
                const treeData = response.data || response; // data 속성이 있으면 사용, 없으면 전체 응답 사용
                console.log('Tree Data:', treeData); // 디버깅용
                
                // 임베딩 상태 로드
                await this.loadEmbeddingStates(treeData);
                
                // 폴더 트리 생성
                this.renderFolderTree(treeData);
            }
        } catch (error) {
            console.error('폴더 트리 로드 실패:', error);
        }
    }

    // 폴더 트리만 로드 (임베딩 상태 없이)
    async loadFolderTreeOnly() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            // 파일 트리 데이터 로드
            const treeResponse = await fetch('/api/folders', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (treeResponse.ok) {
                const response = await treeResponse.json();
                console.log('API Response (no embedding):', response); // 디버깅용
                const treeData = response.data || response;
                console.log('Tree Data (no embedding):', treeData); // 디버깅용
                
                // 폴더 트리 생성 (임베딩 상태 없이)
                this.renderFolderTree(treeData);
                
                // 설정 안내 메시지 표시
                this.showConfigurationPrompt();
            }
        } catch (error) {
            console.error('폴더 트리 로드 실패:', error);
        }
    }

    // 설정 안내 메시지 표시
    showConfigurationPrompt() {
        const detailsElement = document.getElementById('knowledgeItemDetails');
        if (detailsElement) {
            detailsElement.innerHTML = `
                <div class="config-prompt">
                    <div class="config-icon">⚙️</div>
                    <div class="config-title">임베딩 설정이 필요합니다</div>
                    <div class="config-desc">
                        RAG 기능을 사용하려면 먼저 임베딩 모델을 설정해야 합니다.<br>
                        왼쪽에서 Ollama 또는 OpenAI 모델을 선택하고 설정을 저장해주세요.
                    </div>
                    <div class="config-actions">
                        <button class="action-btn primary" onclick="document.querySelector('.model-option[data-model=ollama]').click()">
                            🤖 Ollama 설정하기
                        </button>
                        <button class="action-btn" onclick="document.querySelector('.model-option[data-model=openai]').click()">
                            🚀 OpenAI 설정하기
                        </button>
                    </div>
                </div>
            `;
        }
    }

    // 폴더 트리 렌더링
    renderFolderTree(treeData) {
        const container = document.getElementById('knowledgeFolderTree');
        if (!container || !treeData) return;

        // 트리 데이터 캐시
        this.treeData = treeData;

        const html = this.generateTreeHTML(treeData, 0);
        container.innerHTML = html || '<div class="empty-state">파일이 없습니다.</div>';
        
        // 이벤트 리스너 추가
        this.addTreeEventListeners(container);
    }

    // 트리 이벤트 리스너 추가
    addTreeEventListeners(container) {
        // 기존 이벤트 리스너 제거
        container.removeEventListener('click', this.handleTreeClick);
        
        // 새 이벤트 리스너 추가
        this.handleTreeClick = (event) => {
            console.log('트리 클릭됨', event.target);
            const treeNode = event.target.closest('.tree-node');
            console.log('tree-node 찾음:', treeNode);
            if (!treeNode) return;
            
            const type = treeNode.dataset.type;
            const id = treeNode.dataset.id;
            console.log('type:', type, 'id:', id);
            
            if (type === 'folder') {
                // 폴더 토글 기능
                console.log('폴더 토글 실행');
                this.toggleFolder(treeNode);
                // 폴더 선택 기능도 실행
                console.log('폴더 선택 실행');
                this.selectKnowledgeItem(treeNode, type, id);
            } else if (type && id) {
                // 파일 선택 기능
                console.log('파일 선택 실행');
                this.selectKnowledgeItem(treeNode, type, id);
            }
        };
        
        container.addEventListener('click', this.handleTreeClick);
    }

    // 폴더 접기/펼치기 토글 기능
    toggleFolder(folderElement) {
        console.log('toggleFolder 호출됨', folderElement);
        
        // 폴더 ID를 가져옴
        const folderId = folderElement.dataset.id;
        console.log('폴더 ID:', folderId);
        
        if (!folderId) return;
        
        const treeItem = folderElement.closest('.tree-item');
        console.log('tree-item 찾음:', treeItem);
        
        const folderChildren = treeItem ? treeItem.querySelector('.folder-children') : null;
        console.log('folder-children 찾음:', folderChildren);
        
        if (folderChildren) {
            // expandedFolders Set을 기준으로 상태 토글
            if (this.expandedFolders.has(folderId)) {
                // 접기
                console.log('접기 실행');
                this.expandedFolders.delete(folderId);
                folderChildren.classList.add('collapsed');
                folderChildren.style.maxHeight = '0px';
            } else {
                // 펼치기
                console.log('펼치기 실행');
                this.expandedFolders.add(folderId);
                folderChildren.classList.remove('collapsed');
                folderChildren.style.maxHeight = folderChildren.scrollHeight + 'px';
            }
        } else {
            console.log('folder-children을 찾을 수 없음');
        }
    }

    // 트리 HTML 생성
    generateTreeHTML(data, level = 0) {
        // console.log(`generateTreeHTML called with data:`, data, `level: ${level}`); // 디버깅용
        
        // data가 배열인 경우 (루트 레벨)
        if (Array.isArray(data)) {
            // console.log(`Processing array with ${data.length} items`); // 디버깅용
            let html = '';
            for (const item of data) {
                html += this.generateTreeHTML(item, level);
            }
            return html;
        }
        
        // data가 객체인 경우 (개별 폴더나 파일)
        if (!data) {
            console.log('No data'); // 디버깅용
            return '';
        }
        
        let html = '';
        
        // 폴더인 경우
        if (data.type === 'folder') {
            // console.log(`Processing folder: ${data.name}`); // 디버깅용
            const folderStats = this.getFolderEmbeddingStats(data);
            html += `
                <div class="tree-item">
                    <div class="tree-node folder" 
                         data-type="folder" 
                         data-id="${data.name}"
                         style="margin-left: ${level * 20}px;">
                        <div class="node-icon">📁</div>
                        <div class="node-content">
                            <div class="node-name">${data.name}</div>
                            <div class="folder-summary">${folderStats.completed}/${folderStats.total}</div>
                        </div>
                    </div>
            `;
            
            // 하위 항목들을 folder-children으로 감싸기
            if ((data.children && data.children.length > 0) || (data.files && data.files.length > 0)) {
                // 폴더가 확장되어 있지 않으면 collapsed 클래스 추가
                const isExpanded = this.expandedFolders && this.expandedFolders.has(data.name);
                html += `<div class="folder-children ${isExpanded ? '' : 'collapsed'}">
`;
                
                // 하위 폴더들 (children) 렌더링
                if (data.children && data.children.length > 0) {
                    for (const child of data.children) {
                        html += this.generateTreeHTML(child, level + 1);
                    }
                }
                
                // 폴더 내 파일들 렌더링
                if (data.files && data.files.length > 0) {
                    for (const file of data.files) {
                        html += this.generateTreeHTML({ ...file, type: 'file' }, level + 1);
                    }
                }
                
                html += `</div>`;
            }
            
            html += '</div>';
        }
        // 파일인 경우 (type이 없어도 파일로 처리)
        else {
            // console.log('Processing as file:', data); // 디버깅용
            const embeddingData = this.embeddingData.get(data.id);
            const status = embeddingData?.status || 'none';
            const displayName = data.filename || data.name || '이름 없는 파일';
            
            html += `
                <div class="tree-item">
                    <div class="tree-node file" 
                         data-type="file" 
                         data-id="${data.id}"
                         style="margin-left: ${level * 20}px;">
                        <div class="node-icon">📄</div>
                        <div class="node-content">
                            <div class="node-name" title="${displayName}">${displayName}</div>
                            <div class="embedding-indicator ${status}"></div>
                        </div>
                    </div>
                </div>
            `;
        }
        
        return html;
    }

    // 폴더의 임베딩 통계 계산
    getFolderEmbeddingStats(folder) {
        let total = 0;
        let completed = 0;
        
        // 현재 폴더의 파일들 확인
        if (folder.files && folder.files.length > 0) {
            total += folder.files.length;
            folder.files.forEach(file => {
                const embeddingData = this.embeddingData.get(file.id);
                if (embeddingData?.status === 'completed') {
                    completed++;
                }
            });
        }
        
        // 하위 폴더들 재귀적으로 확인 (children 속성 사용)
        if (folder.children && folder.children.length > 0) {
            folder.children.forEach(subFolder => {
                const subStats = this.getFolderEmbeddingStats(subFolder);
                total += subStats.total;
                completed += subStats.completed;
            });
        }
        
        return { total, completed };
    }

    // 임베딩 설정 로드
    async loadEmbeddingSettings() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return false;

            const response = await fetch('/api/knowledge/settings', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const settings = await response.json();
                if (settings && settings.configured) {
                    this.applyEmbeddingSettings(settings);
                    // Ollama 모델 목록 로드
                    console.log('🚀 설정 로드 후 Ollama 모델 목록 로드 시작');
                    await this.loadOllamaModels();
                    return true; // 설정이 있음
                }
            }
            
            // 설정이 없어도 모델 목록은 로드
            console.log('🚀 설정 없음, Ollama 모델 목록 로드 시작');
            await this.loadOllamaModels();
            return false; // 설정이 없음
        } catch (error) {
            console.error('임베딩 설정 로드 실패:', error);
            return false;
        }
    }

    // 임베딩 설정 적용
    applyEmbeddingSettings(settings) {
        // 모델 선택 적용
        const modelOptions = document.querySelectorAll('.model-option');
        modelOptions.forEach(option => {
            option.classList.remove('selected');
            if (option.dataset.model === settings.provider) {
                option.classList.add('selected');
            }
        });

        // 설정 영역 표시
        this.toggleModelSettings(settings.provider);

        // 모델명 설정
        if (settings.provider === 'ollama') {
            const select = document.getElementById('ollamaEmbeddingModel');
            if (select) {
                // 모델이 로드된 후 설정 적용
                setTimeout(() => {
                    select.value = settings.model_name || 'nomic-embed-text';
                }, 100);
            }
        } else if (settings.provider === 'openai') {
            const select = document.getElementById('openaiEmbeddingModelSelect');
            const input = document.getElementById('openaiEmbeddingModel');
            const baseUrlInput = document.getElementById('openaiEmbeddingBaseUrl');

            if (select && input) {
                const modelName = settings.model_name || 'text-embedding-3-small';
                const predefinedModels = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'];

                if (predefinedModels.includes(modelName)) {
                    // 기본 모델
                    // select에서 선택, input은 비활성화 상태로 값 복사
                    select.value = modelName;
                    input.value = modelName;
                    input.disabled = true;
                } else {
                    // 커스텀 모델
                    // select는 'custom', input 활성화하여 값 표시
                    select.value = 'custom';
                    input.value = modelName;
                    input.disabled = false;
                }
            }

            if (baseUrlInput) baseUrlInput.value = settings.base_url || '';
        }
    }

    // Ollama 모델 목록 로드
    async loadOllamaModels() {
        console.log('🔄 loadOllamaModels 함수 시작');
        
        const modelSelect = document.getElementById('ollamaEmbeddingModel');
        const deleteModelSelect = document.getElementById('embeddingDeleteModelSelect');
        
        if (!modelSelect) {
            console.error('❌ ollamaEmbeddingModel 요소를 찾을 수 없음');
            return;
        }

        console.log('✅ ollamaEmbeddingModel 요소 찾음:', modelSelect);

        try {
            // 기존 옵션들 제거 (로딩 메시지 제외)
            modelSelect.innerHTML = '<option value="" disabled>모델을 불러오는 중...</option>';
            if (deleteModelSelect) {
                deleteModelSelect.innerHTML = '<option value="" disabled>모델을 불러오는 중...</option>';
            }
            console.log('⏳ 로딩 메시지 설정 완료');

            // 직접 Ollama API 호출하여 모델 목록 가져오기
            const token = localStorage.getItem('token');
            console.log('🔑 토큰:', token ? '있음' : '없음');
            
            console.log('🌐 API 호출 시작: /api/models/local');
            const response = await fetch('/api/models/local', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('📡 API 응답 상태:', response.status, response.statusText);

            if (response.ok) {
                const data = await response.json();
                console.log('📋 Ollama 모델 목록 응답:', data);
                
                // 모델 목록이 있는 경우
                if (data.models && data.models.length > 0) {
                    console.log(`✅ ${data.models.length}개의 모델 발견`);
                    modelSelect.innerHTML = '';
                    if (deleteModelSelect) {
                        deleteModelSelect.innerHTML = '';
                    }
                    
                    // 기본 선택 옵션 추가
                    modelSelect.add(new Option('설치된 모델을 선택하세요', '', true, false));
                    if (deleteModelSelect) {
                        deleteModelSelect.add(new Option('삭제할 모델을 선택하세요', '', true, false));
                    }

                    // 모델들 추가
                    data.models.forEach((model, index) => {
                        const modelName = model.name || model;
                        console.log(`  ${index + 1}. ${modelName}`);
                        const newOption = new Option(modelName, modelName);
                        const deleteOption = new Option(modelName, modelName);
                        modelSelect.add(newOption);
                        if (deleteModelSelect) {
                            deleteModelSelect.add(deleteOption);
                        }
                    });
                    console.log('✅ 모든 모델 추가 완료');
                } else {
                    console.log('⚠️ 설치된 모델이 없음');
                    modelSelect.innerHTML = '<option value="" disabled>설치된 모델이 없습니다</option>';
                    if (deleteModelSelect) {
                        deleteModelSelect.innerHTML = '<option value="" disabled>설치된 모델이 없습니다</option>';
                    }
                }
            } else {
                const errorText = await response.text();
                console.error('❌ API 호출 실패:', response.status, errorText);
                throw new Error(`API 호출 실패: ${response.status} ${errorText}`);
            }
        } catch (error) {
            console.error('💥 Ollama 모델 목록 로드 실패:', error);
            modelSelect.innerHTML = '<option value="" disabled>모델 로드 실패</option>';
            if (deleteModelSelect) {
                deleteModelSelect.innerHTML = '<option value="" disabled>모델 로드 실패</option>';
            }
        }
    }


    // 항목 선택 처리
    selectKnowledgeItem(element, type, id) {
        // 모든 트리 노드에서 selected 클래스 제거
        document.querySelectorAll('.tree-node').forEach(node => {
            node.classList.remove('selected');
        });
        
        // 선택된 노드에 selected 클래스 추가
        element.classList.add('selected');
        
        // 상세 정보 업데이트
        this.updateItemDetails(type, id);
    }

    // 상세 정보 업데이트
    updateItemDetails(type, id) {
        const detailsElement = document.getElementById('knowledgeItemDetails');
        if (!detailsElement) return;

        if (type === 'file') {
            this.updateFileDetails(id, detailsElement);
        } else if (type === 'folder') {
            this.updateFolderDetails(id, detailsElement);
        }
    }

    // 파일 상세 정보 업데이트
    updateFileDetails(fileId, container) {
        const embeddingData = this.embeddingData.get(fileId);
        const fileInfo = this.findFileInTree(fileId);
        const status = embeddingData?.status || 'none';
        
        const statusConfig = {
            completed: {
                text: '✅ 임베딩 완료',
                class: 'completed',
                actions: [
                    { text: '💬 채팅에서 사용', class: 'primary', action: 'use-in-chat' },
                    { text: '🔄 재생성', class: '', action: 'regenerate' },
                    { text: '🗑️ 삭제', class: 'danger', action: 'delete' }
                ]
            },
            processing: {
                text: '🔄 처리 중',
                class: 'processing',
                actions: [
                    { text: '❌ 취소', class: 'danger', action: 'cancel' }
                ]
            },
            failed: {
                text: '❌ 임베딩 실패',
                class: 'failed',
                actions: [
                    { text: '🔄 재시도', class: 'primary', action: 'regenerate' },
                    { text: '🗑️ 삭제', class: 'danger', action: 'delete' }
                ]
            },
            cancelled: {
                text: '⏹️ 취소됨',
                class: 'cancelled',
                actions: [
                    { text: '▶️ 임베딩 생성', class: 'primary', action: 'create-embedding' },
                    { text: '🗑️ 삭제', class: 'danger', action: 'delete' }
                ]
            },
            none: {
                text: '⚪ 임베딩 없음',
                class: 'none',
                actions: [
                    { text: '▶️ 임베딩 생성', class: 'primary', action: 'create-embedding' }
                ]
            }
        };

        // 안전한 기본값 설정
        const config = statusConfig[status] || statusConfig.none;
        const progressHTML = status === 'processing' ? `
            <div class="progress-section">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${embeddingData?.progress || 0}%;"></div>
                </div>
                <div class="progress-text">
                    임베딩 생성 중... ${embeddingData?.progress || 0}% 완료
                </div>
            </div>
        ` : '';

        // 상세 영역에 파일 ID 저장
        container.dataset.fileId = fileId;
        
        container.innerHTML = `
            <div class="detail-header">
                <div class="detail-title">
                    📄 파일명: ${embeddingData?.filename || fileInfo?.filename || fileInfo?.name || '알 수 없음'}
                </div>
                <div class="status-badge ${config.class}">
                    ${config.text}
                </div>
            </div>

            <div class="detail-meta">
                <div class="meta-item">
                    <div class="meta-label">임베딩 모델</div>
                    <div class="meta-value">${embeddingData?.model_name || 'N/A'}</div>
                </div>
                <div class="meta-item">
                    <div class="meta-label">생성 날짜</div>
                    <div class="meta-value">${this.formatDate(embeddingData?.created_at)}</div>
                </div>
                ${embeddingData?.total_chunks ? `
                <div class="meta-item">
                    <div class="meta-label">청크 수</div>
                    <div class="meta-value">${embeddingData.total_chunks}개</div>
                </div>` : ''}
            </div>

            ${progressHTML}

            <div class="action-buttons">
                ${config.actions.map(action => 
                    `<button class="action-btn ${action.class}" data-action="${action.action}" data-file-id="${fileId}">${action.text}</button>`
                ).join('')}
            </div>
        `;

        // 액션 버튼 이벤트 리스너 추가
        container.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const action = btn.dataset.action;
                const fileId = btn.dataset.fileId;
                
                if (action && fileId) {
                    await this.handleFileAction(action, fileId);
                }
            });
        });
    }

    // 폴더 상세 정보 업데이트
    updateFolderDetails(folderId, container) {
        // 폴더 정보 찾기
        const folderInfo = this.findFolderInTree(folderId);
        const folderName = folderInfo?.name || folderId || '알 수 없음';
        
        // 폴더 상세 정보 구현
        container.innerHTML = `
            <div class="detail-header">
                <div class="detail-title">
                    📁 폴더 정보: ${folderName}
                </div>
            </div>
            <div class="action-buttons">
                <button class="action-btn primary" data-folder-action="embed-all" data-folder-id="${folderId}">🚀 폴더 전체 임베딩</button>
                <button class="action-btn" data-folder-action="retry-failed" data-folder-id="${folderId}">🔄 실패 항목 재시도</button>
                <button class="action-btn" data-folder-action="view-report" data-folder-id="${folderId}">📊 상세 리포트</button>
            </div>
            <div class="folder-action-notice" style="
                background-color: var(--bg-tertiary);
                border: 1px solid var(--border-secondary);
                border-left: 4px solid var(--error);
                border-radius: 8px;
                padding: 12px;
                margin-top: 16px;
                font-size: 13px;
                color: var(--text-secondary);
            ">
                <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-error); margin-bottom: 4px;">
                    <span style="font-size: 16px;">❗</span>
                    <span>필독: 중요 동작 원칙</span>
                </div>
                <p style="margin: 0; line-height: 1.6;">
                    '폴더 전체 임베딩' 실행 시, 폴더 내 모든 파일에 <b>현재 설정된 임베딩 모델이 강제로 적용</b>됩니다.
                </p>
                <p style="margin: 8px 0 0 0; line-height: 1.6;">
                    서로 다른 모델로 임베딩된 파일이 섞이면 RAG 검색 기능이 오작동하며, 이는 지원되지 않는 사용 방식입니다. 정확한 검색을 원하시면, <b>모든 파일을 하나의 모델로 통일하여 재임베딩</b> 하십시오.
                </p>
            </div>
        `;

        // 폴더 액션 버튼 이벤트 리스너 추가
        container.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const action = btn.dataset.folderAction;
                const folderId = btn.dataset.folderId;
                
                if (action && folderId) {
                    await this.handleFolderAction(action, folderId);
                }
            });
        });
    }

    // 파일 액션 처리
    async handleFileAction(action, fileId) {
        switch (action) {
            case 'use-in-chat':
                // 채팅 페이지로 전환하고 해당 파일 선택
                this.switchToChatWithFile(fileId);
                break;
            case 'create-embedding':
                await this.createEmbedding(fileId);
                break;
            case 'regenerate':
                await this.regenerateEmbedding(fileId);
                break;
            case 'cancel':
                await this.cancelEmbedding(fileId);
                break;
            case 'delete':
                await this.deleteEmbedding(fileId);
                break;
            // 다른 액션들...
        }
    }

    // 폴더 액션 처리
    async handleFolderAction(action, folderId) {
        switch (action) {
            case 'embed-all':
                await this.embedAllInFolder(folderId);
                break;
            // 다른 액션들...
        }
    }

    // 채팅 페이지로 전환 (특정 파일 선택)
    switchToChatWithFile(fileId) {
        // 메인 앱에서 페이지 전환 처리
        if (window.switchView) {
            window.switchView('chat');
            // 파일 선택 로직 (fileManager와 연동)
            setTimeout(() => {
                if (window.fileManager && window.fileManager.selectFile) {
                    window.fileManager.selectFile(fileId);
                }
            }, 100);
        }
    }

    // 임베딩 모델 선택
    async selectEmbeddingModel(element) {
        console.log('🎯 모델 공급자 선택:', element.dataset.model);
        
        document.querySelectorAll('.model-option').forEach(option => {
            option.classList.remove('selected');
        });
        element.classList.add('selected');
        
        const modelProvider = element.dataset.model;
        
        // 설정 영역 표시/숨김
        this.toggleModelSettings(modelProvider);
        
        // 선택된 모델에 따라 자동으로 설정 저장
        await this.autoSaveModelSelection(modelProvider);
    }

    // 모델 선택시 자동 설정 저장
    async autoSaveModelSelection(modelProvider) {
        try {
            let settings = null;
            
            if (modelProvider === 'ollama') {
                // Ollama 모델 선택시 - 현재 선택된 모델이 있으면 사용, 없으면 기본값 사용
                const modelSelect = document.getElementById('ollamaEmbeddingModel');
                let selectedModel = modelSelect?.value || '';
                
                // 선택된 모델이 없으면 첫 번째 유효한 모델 사용
                if (!selectedModel || selectedModel === '') {
                    const options = modelSelect?.querySelectorAll('option:not([disabled])');
                    if (options && options.length > 1) { // 첫 번째는 보통 placeholder
                        selectedModel = options[1].value;
                        modelSelect.value = selectedModel;
                    }
                }
                
                if (selectedModel && selectedModel !== '') {
                    settings = {
                        model: 'ollama',
                        ollama_model: selectedModel
                    };
                }
            } else if (modelProvider === 'openai') {
                // OpenAI 모델 선택시 - 기본값 사용
                const modelSelect = document.getElementById('openaiEmbeddingModelSelect');
                const modelInput = document.getElementById('openaiEmbeddingModel');
                const baseUrlInput = document.getElementById('openaiEmbeddingBaseUrl');

                const selectedModel = modelInput?.value?.trim() || 'text-embedding-3-small';
                const baseUrl = baseUrlInput?.value?.trim() || null;

                settings = {
                    model: 'openai',
                    openai_model: selectedModel,
                    base_url: baseUrl,
                };
            }
            
            // 설정이 준비되면 저장
            if (settings) {
                console.log('🔄 자동 설정 저장:', settings);
                await this.saveEmbeddingSettings(settings);
            }
        } catch (error) {
            console.error('자동 설정 저장 실패:', error);
            // 자동 저장 실패는 사용자에게 알리지 않음 (시스템 로그만)
        }
    }

    // Ollama 모델 삭제
    async deleteModel() {
        const deleteSelect = document.getElementById('embeddingDeleteModelSelect');
        if (!deleteSelect) {
            console.error('삭제 모델 선택 요소를 찾을 수 없습니다');
            return;
        }

        const modelName = deleteSelect.value;
        if (!modelName) {
            showNotification('삭제할 모델을 선택해주세요.', 'warning');
            return;
        }

        // 확인 대화상자
        if (!confirm(`정말로 "${modelName}" 모델을 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`)) {
            return;
        }

        const deleteBtn = document.getElementById('embeddingDeleteModelBtn');
        const originalText = deleteBtn?.innerHTML || '🗑️';
        
        try {
            if (deleteBtn) {
                deleteBtn.innerHTML = '⏳ 삭제 중...';
                deleteBtn.disabled = true;
            }

            const token = localStorage.getItem('token');
            const response = await fetch('/api/models/local/delete', {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model_name: modelName }) // model -> model_name으로 수정
            });

            const result = await response.json();
            
            if (response.ok) {
                showNotification(`✅ 모델 "${modelName}"이 삭제되었습니다.`, 'success');
                // 모델 목록 새로고침
                await this.loadOllamaModels();
            } else {
                showNotification(`❌ 모델 삭제 실패: ${result.detail || result.message || '알 수 없는 오류'}`, 'error');
            }
        } catch (error) {
            console.error('모델 삭제 실패:', error);
            showNotification('모델 삭제 중 오류가 발생했습니다.', 'error');
        } finally {
            if (deleteBtn) {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = originalText;
            }
        }
    }


    

    // 모델별 설정 영역 토글
    toggleModelSettings(selectedModel) {
        const ollamaSettings = document.getElementById('ollamaEmbeddingSettings');
        const openaiSettings = document.getElementById('openaiEmbeddingSettings');
        
        if (ollamaSettings && openaiSettings) {
            if (selectedModel === 'ollama') {
                ollamaSettings.style.display = 'block';
                openaiSettings.style.display = 'none';
            } else if (selectedModel === 'openai') {
                ollamaSettings.style.display = 'none';
                openaiSettings.style.display = 'block';
            }
        }
    }

    // Ollama 임베딩 모델 테스트
    async testOllamaEmbeddingModel() {
        const modelInput = document.getElementById('ollamaEmbeddingModel');
        const testBtn = document.querySelector('.test-model-btn[data-action="test-ollama-model"]');
        
        if (!modelInput || !testBtn) return;
        
        const modelName = modelInput.value.trim();
        if (!modelName) {
            showNotification('모델을 선택해주세요.', 'warning');
            return;
        }

        const originalText = '테스트 및 저장'; // 버튼 기본 텍스트
        testBtn.innerHTML = '⏳ 테스트 중...';
        testBtn.disabled = true;

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/knowledge/test-embedding-model', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ provider: 'ollama', model: modelName })
            });

            const result = await response.json();
            
            if (result.success) {
                testBtn.innerHTML = '✅ 저장됨';
                showNotification(`✅ 모델 테스트 성공: ${modelName}. 설정을 저장합니다.`, 'success');
                
                // 테스트 성공 시 설정 저장
                const settings = { model: 'ollama', ollama_model: modelName };
                await this.saveEmbeddingSettings(settings);

            } else {
                testBtn.innerHTML = '❌ 실패';
                showNotification(`❌ 모델 테스트 실패: ${result.message || '알 수 없는 오류'}`, 'error');
            }
        } catch (error) {
            console.error('모델 테스트 실패:', error);
            testBtn.innerHTML = '❌ 오류';
            showNotification('모델 테스트 중 오류가 발생했습니다.', 'error');
        } finally {
            setTimeout(() => {
                testBtn.disabled = false;
                testBtn.innerHTML = originalText;
            }, 2000);
        }
    }

    // OpenAI 임베딩 모델 테스트
    async testOpenaiEmbeddingModel() {
        const modelSelect = document.getElementById('openaiEmbeddingModel');
        const baseUrlInput = document.getElementById('openaiEmbeddingBaseUrl');
        const testBtn = document.querySelector('.test-model-btn[data-action="test-openai-model"]');
        
        if (!modelSelect || !testBtn) return;
        
        const modelName = modelSelect.value;
        const baseUrl = baseUrlInput?.value?.trim() || null;
        if (!modelName) {
            showNotification('모델을 선택해주세요.', 'warning');
            return;
        }

        const originalText = '테스트 및 저장'; // 버튼 기본 텍스트
        testBtn.innerHTML = '⏳ 테스트 중...';
        testBtn.disabled = true;

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/knowledge/test-embedding-model', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ provider: 'openai', model: modelName })
            });

            const result = await response.json();
            
            if (result.success) {
                testBtn.innerHTML = '✅ 저장됨';
                showNotification(`✅ 모델 테스트 성공: ${modelName}. 설정을 저장합니다.`, 'success');

                // 테스트 성공 시 설정 저장
                const settings = { model: 'openai', openai_model: modelName };
                await this.saveEmbeddingSettings(settings);

            } else {
                testBtn.innerHTML = '❌ 실패';
                showNotification(`❌ 모델 테스트 실패: ${result.message || '알 수 없는 오류'}`, 'error');
            }
        } catch (error) {
            console.error('모델 테스트 실패:', error);
            testBtn.innerHTML = '❌ 오류';
            showNotification('모델 테스트 중 오류가 발생했습니다.', 'error');
        } finally {
            setTimeout(() => {
                testBtn.disabled = false;
                testBtn.innerHTML = originalText;
            }, 2000);
        }
    }

    // 임베딩 설정 저장
    async saveEmbeddingSettings(settings) {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            console.log('💾 임베딩 설정 저장 시도:', settings);
            
            const response = await fetch('/api/knowledge/settings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(settings)
            });

            console.log('📡 설정 저장 API 응답:', response.status, response.statusText);

            if (response.ok) {
                showNotification('임베딩 설정이 저장되었습니다.', 'success');
                // 설정 변경으로 인한 UI 갱신
                await this.loadEmbeddingSettings();
                this.refreshUI();
            } else {
                const errorData = await response.json();
                console.error('❌ 설정 저장 API 오류:', errorData);
                showNotification(`설정 저장 실패: ${errorData.detail || '알 수 없는 오류'}`, 'error');
            }
        } catch (error) {
            console.error('설정 저장 실패:', error);
            showNotification('설정 저장에 실패했습니다.', 'error');
        }
    }


    // 임베딩 삭제
    async deleteEmbedding(fileId) {
        const confirm = window.confirm('임베딩을 삭제하시겠습니까?');
        if (!confirm) return;

        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(`/api/knowledge/embeddings/${fileId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                showNotification('임베딩이 삭제되었습니다.', 'success');
                // 즉시 상태 업데이트
                this.embeddingData.delete(fileId);
                this.refreshUI();
            } else {
                const error = await response.json();
                showNotification(`임베딩 삭제 실패: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('임베딩 삭제 실패:', error);
            showNotification('임베딩 삭제에 실패했습니다.', 'error');
        }
    }

    // 임베딩 취소
    async cancelEmbedding(fileId) {
        const confirm = window.confirm('임베딩 처리를 취소하시겠습니까?');
        if (!confirm) return;

        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(`/api/knowledge/embeddings/${fileId}/cancel`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                showNotification('임베딩 처리가 취소되었습니다.', 'success');
                // 즉시 상태 업데이트
                const embeddingData = this.embeddingData.get(fileId);
                if (embeddingData) {
                    embeddingData.status = 'cancelled';
                    embeddingData.error_message = '사용자에 의해 취소됨';
                }
                this.refreshUI();
            } else {
                const error = await response.json();
                showNotification(`임베딩 취소 실패: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('임베딩 취소 실패:', error);
            showNotification('임베딩 취소에 실패했습니다.', 'error');
        }
    }

    // 임베딩 생성
    async createEmbedding(fileId) {
        try {
            const fileInfo = this.findFileInTree(fileId);
            if (!fileInfo) {
                showNotification('파일 정보를 찾을 수 없습니다.', 'error');
                return;
            }

            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(`/api/knowledge/embeddings/${fileId}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    filename: fileInfo.filename || fileInfo.name
                })
            });

            if (response.ok) {
                showNotification('임베딩 생성이 시작되었습니다.', 'success');
                
                // 즉시 상태 업데이트
                this.embeddingData.set(fileId, {
                    file_id: fileId,
                    filename: fileInfo.filename || fileInfo.name,
                    status: 'processing',
                    total_chunks: 0,
                    completed_chunks: 0,
                    progress: 0,
                    created_at: new Date()
                });
                this.refreshUI();
                
                // 간단한 진행률 업데이트: 임베딩 시작 후 주기적으로 상태 확인
                this.startSimpleProgressCheck(fileId);
            } else {
                const error = await response.json();
                let errorMsg = error.detail;
                if (errorMsg.includes('처리된 PDF 파일을 찾을 수 없습니다')) {
                    errorMsg = '이 파일은 아직 PDF 처리가 완료되지 않았습니다.\n먼저 채팅 섹션에서 파일을 업로드하고 처리를 완료해주세요.';
                }
                showNotification(`임베딩 생성 실패:\n${errorMsg}`, 'error');
            }
        } catch (error) {
            console.error('임베딩 생성 실패:', error);
            showNotification('임베딩 생성에 실패했습니다.', 'error');
        }
    }

    // 임베딩 재생성
    async regenerateEmbedding(fileId) {
        const confirm = window.confirm('기존 임베딩을 삭제하고 다시 생성하시겠습니까?');
        if (!confirm) return;

        await this.deleteEmbedding(fileId);
        setTimeout(() => {
            this.createEmbedding(fileId);
        }, 1000);
    }

    // 파일 트리에서 파일 찾기
    findFileInTree(fileId) {
        let result = null;
        
        const searchInData = (items) => {
            if (!items) return;
            
            // 배열인 경우
            if (Array.isArray(items)) {
                for (const item of items) {
                    // 파일인 경우 직접 확인
                    if (item.type === 'file' && item.id === fileId) {
                        result = item;
                        return;
                    }
                    // 폴더인 경우 재귀 검색
                    else if (item.type === 'folder') {
                        // 폴더 내 파일들 확인
                        if (item.files && Array.isArray(item.files)) {
                            for (const file of item.files) {
                                if (file.id === fileId) {
                                    result = { ...file, filename: file.filename || file.name };
                                    return;
                                }
                            }
                        }
                        // 하위 폴더들 확인
                        if (item.children && Array.isArray(item.children)) {
                            searchInData(item.children);
                        }
                    }
                    if (result) return;
                }
            }
        };
        
        if (this.treeData) {
            searchInData(this.treeData);
        }
        
        return result;
    }

    // 폴더 트리에서 폴더 찾기
    findFolderInTree(folderId) {
        let result = null;
        
        const searchInData = (items) => {
            if (!items) return;
            
            // 배열인 경우
            if (Array.isArray(items)) {
                for (const item of items) {
                    // 폴더인 경우 확인
                    if (item.type === 'folder' && (item.id === folderId || item.name === folderId)) {
                        result = item;
                        return;
                    }
                    // 하위 폴더들 확인
                    if (item.children && Array.isArray(item.children)) {
                        searchInData(item.children);
                    }
                    if (result) return;
                }
            }
        };
        
        if (this.treeData) {
            searchInData(this.treeData);
        }
        
        return result;
    }

    // UI 전체 새로고침
    refreshUI() {
        // 폴더 트리 다시 렌더링
        this.renderFolderTree(this.treeData);
        
        // 통계 업데이트
        this.updateEmbeddingStats();
        
        // DOM 업데이트 후 상세 정보 업데이트
        requestAnimationFrame(() => {
            const selectedNode = document.querySelector('.tree-node.selected');
            
            if (selectedNode) {
                const fileId = selectedNode.dataset.id;
                const type = selectedNode.dataset.type;
                
                if (type === 'file' && fileId) {
                    this.updateItemDetails('file', fileId);
                }
            } else {
                // 현재 상세 영역에 표시된 파일 ID 찾기
                const detailsElement = document.getElementById('knowledgeItemDetails');
                const currentFileId = this.getCurrentDisplayedFileId(detailsElement);
                
                if (currentFileId) {
                    this.updateItemDetails('file', currentFileId);
                }
            }
        });
    }

    // 현재 상세 영역에 표시된 파일 ID 가져오기
    getCurrentDisplayedFileId(detailsElement) {
        if (!detailsElement) return null;
        
        // 상세 영역에 data-file-id 속성이 있는지 확인
        const fileId = detailsElement.dataset.fileId;
        if (fileId) return fileId;
        
        // action-btn 요소에서 data-file-id 찾기
        const actionBtn = detailsElement.querySelector('.action-btn[data-file-id]');
        if (actionBtn && actionBtn.dataset.fileId) {
            console.log('🔍 액션 버튼에서 파일 ID 찾음:', actionBtn.dataset.fileId);
            return actionBtn.dataset.fileId;
        }
        
        // HTML 내용에서 파일 ID 추출 (embeddingData의 키와 매칭)
        for (let [id, data] of this.embeddingData.entries()) {
            if (detailsElement.innerHTML.includes(data.filename)) {
                console.log('🔍 파일명으로 파일 ID 찾음:', id, data.filename);
                return id;
            }
        }
        
        console.log('❌ getCurrentDisplayedFileId: 파일 ID를 찾을 수 없음');
        return null;
    }

    // 폴더의 모든 파일 임베딩
    async embedAllInFolder(folderId) {
        const confirm = window.confirm('폴더 내 모든 파일의 임베딩을 생성하시겠습니까?');
        if (!confirm) return;

        showNotification('폴더 임베딩을 시작합니다...', 'info');
        // 구현 필요
    }

    // 임베딩 상태 갱신
    async refreshEmbeddingStatus() {
        await this.loadFolderTreeWithEmbedding();
        this.updateEmbeddingStats();
    }

    // 통계 업데이트
    updateEmbeddingStats() {
        let completed = 0;
        let processing = 0;
        let none = 0;

        this.embeddingData.forEach(data => {
            switch (data.status) {
                case 'completed': completed++; break;
                case 'processing': processing++; break;
                default: none++; break;
            }
        });

        const completedElement = document.getElementById('completedCount');
        const processingElement = document.getElementById('processingCount');
        const noneElement = document.getElementById('noneCount');
        
        if (completedElement) completedElement.textContent = `${completed} 완료`;
        if (processingElement) processingElement.textContent = `${processing} 처리중`;
        if (noneElement) noneElement.textContent = `${none} 대기`;
    }

    // 폴더의 모든 파일 임베딩
    async embedAllInFolder(folderId) {
        const confirm = window.confirm('폴더 내 모든 파일의 임베딩을 생성하시겠습니까?');
        if (!confirm) return;

        showNotification('폴더 임베딩을 시작합니다...', 'info');
        
        // 폴더의 모든 파일 찾기
        const folderFiles = this.findFilesInFolder(folderId);
        if (folderFiles.length === 0) {
            showNotification('폴더에 파일이 없습니다.', 'warning');
            return;
        }

        // 각 파일에 대해 임베딩 생성
        for (const file of folderFiles) {
            try {
                await this.createEmbedding(file.id);
                // 각 파일 처리 후 잠시 대기
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`파일 ${file.filename} 임베딩 실패:`, error);
            }
        }
        
        showNotification(`${folderFiles.length}개 파일의 임베딩 생성을 시작했습니다.`, 'success');
        // 전체 상태 갱신
        this.refreshUI();
    }

    // 폴더의 모든 파일 찾기
    findFilesInFolder(folderId) {
        const files = [];
        
        const searchInData = (items) => {
            if (!items) return;
            
            if (Array.isArray(items)) {
                for (const item of items) {
                    if (item.type === 'folder' && item.name === folderId) {
                        // 해당 폴더 찾음 - 내부 파일들 수집
                        if (item.files && Array.isArray(item.files)) {
                            item.files.forEach(file => {
                                files.push({
                                    id: file.id,
                                    filename: file.filename || file.name
                                });
                            });
                        }
                        // 하위 폴더도 재귀적으로 검색
                        if (item.children && Array.isArray(item.children)) {
                            item.children.forEach(subFolder => {
                                searchInData([subFolder]);
                            });
                        }
                    } else if (item.type === 'folder' && item.children) {
                        // 다른 폴더의 하위 폴더들 검색
                        searchInData(item.children);
                    }
                }
            }
        };
        
        if (this.treeData) {
            searchInData(this.treeData);
        }
        
        return files;
    }

    // 특정 파일의 최신 상태 확인
    async refreshFileStatus(fileId) {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(`/api/knowledge/embeddings/${fileId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const embedding = await response.json();
                if (embedding) {
                    this.embeddingData.set(fileId, {
                        ...embedding,
                        created_at: new Date(embedding.created_at),
                        updated_at: new Date(embedding.updated_at)
                    });
                } else {
                    // 임베딩이 삭제된 경우
                    this.embeddingData.delete(fileId);
                }
                this.refreshUI();
            }
        } catch (error) {
            console.error('파일 상태 확인 실패:', error);
        }
    }


    // 간단한 진행률 체크 (임베딩 처리 중에만 활성화)
    startSimpleProgressCheck(fileId) {
        // 2초 후부터 시작해서 2초마다 최대 30분까지 확인
        let checkCount = 0;
        const maxChecks = 900; // 30분 (2초 * 900회) 
        
        const checkProgress = async () => {
            if (checkCount >= maxChecks) {
                console.log(`⏰ 진행률 체크 시간 초과: ${fileId}`);
                return;
            }
            
            // console.log(`🔄 진행률 체크 중... (${checkCount + 1}/${maxChecks}): ${fileId}`);
            await this.refreshFileStatus(fileId);
            const embeddingData = this.embeddingData.get(fileId);
            
            // 진행률 업데이트 로그
            if (embeddingData && embeddingData.status === 'processing') {
                console.log(`📊 UI 진행률: ${embeddingData.completed_chunks}/${embeddingData.total_chunks} (${embeddingData.progress || 0}%)`);
            }
            
            if (embeddingData && ['completed', 'failed', 'cancelled'].includes(embeddingData.status)) {
                console.log(`✅ 임베딩 완료/종료: ${fileId} (${embeddingData.status})`);
                return;
            }
            
            checkCount++;
            setTimeout(checkProgress, 2000); // 2초 후 다시 체크
        };
        
        // 2초 후 첫 체크 시작
        setTimeout(checkProgress, 2000);
    }

    // 유틸리티 함수들
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatDate(dateString) {
        if (!dateString) return '-';
        return new Date(dateString).toLocaleDateString('ko-KR');
    }

    // 임베딩 모델 다운로드 (OllamaManager의 pullModel 로직 복사)
    async pullModel() {
        console.log('📥 임베딩 관리 모델 다운로드 시작');
        
        const input = document.getElementById('embeddingPullModelInput');
        const button = document.getElementById('embeddingPullModelBtn');
        const status = document.getElementById('embeddingPullModelStatus');
        
        const modelName = input ? input.value.trim() : '';
        if (!modelName) {
            showNotification('모델 이름을 입력해주세요.', 'error');
            return;
        }

        // AbortController 생성
        this.embeddingDownloadController = new AbortController();

        // 로딩 상태 및 중단 버튼
        if (button) {
            button.disabled = false;
            button.innerHTML = '⏹️ 중단';
            button.onclick = () => this.cancelEmbeddingModelDownload();
        }

        if (status) {
            status.style.display = 'block';
            status.className = 'mt-2 p-2 rounded text-sm bg-blue-50 text-blue-700';
            status.innerHTML = `
                <div class="flex items-center justify-between">
                    <span>모델 '${modelName}' 다운로드 준비 중...</span>
                </div>
                <div class="mt-2">
                    <div class="bg-gray-200 rounded-full h-2">
                        <div id="embeddingDownloadProgress" class="bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                    <div class="flex justify-between text-xs mt-1">
                        <span id="embeddingDownloadPercent">0%</span>
                        <span id="embeddingDownloadSize">0MB / 0MB</span>
                    </div>
                </div>
            `;
        }

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/models/local/download', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model_name: modelName }),
                signal: this.embeddingDownloadController.signal
            });

            if (!response.ok) {
                throw new Error('다운로드 시작 실패');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            const readStream = async () => {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        console.log('✅ 임베딩 모델 다운로드 완료');
                        this.handleEmbeddingDownloadComplete(modelName);
                        return;
                    }

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');

                    lines.forEach(line => {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                this.handleEmbeddingDownloadEvent(data);
                            } catch (e) {
                                console.log('JSON 파싱 오류:', e, 'Line:', line);
                            }
                        }
                    });

                    await readStream();
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log('🚫 스트림 읽기 중단됨 (정상)');
                    } else {
                        console.error('스트림 읽기 오류:', error);
                        this.handleEmbeddingDownloadError(error);
                    }
                }
            };

            await readStream();

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('🚫 임베딩 모델 다운로드가 사용자에 의해 중단됨');
                this.handleEmbeddingDownloadCancelled();
            } else {
                console.error('❌ 임베딩 모델 다운로드 오류:', error);
                this.handleEmbeddingDownloadError(error);
            }
        }
    }

    // 임베딩 모델 다운로드 중단
    cancelEmbeddingModelDownload() {
        if (this.embeddingDownloadController) {
            console.log('🚫 임베딩 모델 다운로드 중단 요청');
            this.embeddingDownloadController.abort();
            this.embeddingDownloadController = null;
        }
    }

    // 임베딩 다운로드 이벤트 처리
    handleEmbeddingDownloadEvent(data) {
        const progressBar = document.getElementById('embeddingDownloadProgress');
        const percentText = document.getElementById('embeddingDownloadPercent');
        const sizeText = document.getElementById('embeddingDownloadSize');
        const statusDiv = document.getElementById('embeddingPullModelStatus');
        
        switch (data.type) {
            case 'start':
                if (statusDiv) statusDiv.className = 'mt-2 p-2 rounded text-sm border border-blue-300 bg-blue-50';
                console.log('📥 임베딩 모델 다운로드 시작');
                break;
                
            case 'progress':
                if (progressBar && percentText && sizeText) {
                    progressBar.style.width = `${data.percentage}%`;
                    percentText.textContent = `${data.percentage}%`;
                    
                    const completedMB = (data.completed / 1024 / 1024).toFixed(1);
                    const totalMB = (data.total / 1024 / 1024).toFixed(1);
                    sizeText.textContent = `${completedMB}MB / ${totalMB}MB`;
                }
                break;
                
            case 'status':
                if (sizeText) {
                    sizeText.textContent = data.status;
                }
                break;
                
            case 'done':
                this.handleEmbeddingDownloadComplete();
                break;
                
            case 'error':
                this.handleEmbeddingDownloadError(new Error(data.error));
                break;
        }
    }

    // 임베딩 다운로드 완료 처리
    handleEmbeddingDownloadComplete(modelName) {
        const button = document.getElementById('embeddingPullModelBtn');
        const status = document.getElementById('embeddingPullModelStatus');
        const input = document.getElementById('embeddingPullModelInput');
        
        if (status) {
            status.className = 'mt-2 p-2 rounded text-sm border border-green-300 bg-green-50';
            status.innerHTML = `
                <div class="flex items-center">
                    <span>✅ 임베딩 모델 '${modelName || ''}' 다운로드 완료!</span>
                </div>
            `;
        }
        
        // 입력 필드 초기화
        if (input) input.value = '';
        
        // 버튼 상태 복원
        if (button) {
            button.disabled = false;
            button.onclick = () => this.pullModel();
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-4 h-4"><path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z"></path><path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z"></path></svg>';
        }
        
        this.embeddingDownloadController = null;
        
        // 모델 목록 새로고침
        setTimeout(() => {
            this.loadOllamaModels();
        }, 2000);
        
        // 5초 후 상태 메시지 숨기기
        setTimeout(() => {
            if (status) status.style.display = 'none';
        }, 5000);
    }

    // 임베딩 다운로드 오류 처리
    handleEmbeddingDownloadError(error) {
        const button = document.getElementById('embeddingPullModelBtn');
        const status = document.getElementById('embeddingPullModelStatus');
        
        if (status) {
            status.className = 'mt-2 p-2 rounded text-sm border border-red-300 bg-red-50';
            status.innerHTML = `
                <div class="flex items-center">
                    <span>❌ 다운로드 오류: ${error.message || '알 수 없는 오류'}</span>
                </div>
            `;
        }
        
        // 버튼 상태 복원
        if (button) {
            button.disabled = false;
            button.onclick = () => this.pullModel();
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-4 h-4"><path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z"></path><path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z"></path></svg>';
        }
        
        this.embeddingDownloadController = null;
        
        // 5초 후 상태 메시지 숨기기
        setTimeout(() => {
            if (status) status.style.display = 'none';
        }, 5000);
    }

    // 임베딩 다운로드 중단 처리
    handleEmbeddingDownloadCancelled() {
        const button = document.getElementById('embeddingPullModelBtn');
        const status = document.getElementById('embeddingPullModelStatus');
        
        if (status) {
            status.className = 'mt-2 p-2 rounded text-sm border border-yellow-300 bg-yellow-50';
            status.innerHTML = `
                <div class="flex items-center">
                    <span>🚫 다운로드가 중단되었습니다.</span>
                </div>
            `;
        }
        
        // 버튼 상태 복원
        if (button) {
            button.disabled = false;
            button.onclick = () => this.pullModel();
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-4 h-4"><path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z"></path><path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.25Z"></path></svg>';
        }
        
        // 3초 후 상태 메시지 숨기기
        setTimeout(() => {
            if (status) status.style.display = 'none';
        }, 3000);
        
        this.embeddingDownloadController = null;
    }

    // 지식 관리 전용 폴더 생성 기능
    createNewFolder() {
        // 기존 folderTreeManager 기능 활용
        if (window.folderTreeManager && window.folderTreeManager.createNewFolder) {
            window.folderTreeManager.createNewFolder();
        } else {
            showNotification('폴더 관리 기능을 사용할 수 없습니다.', 'error');
        }
    }

    // 지식 관리 전용 파일 업로드 기능
    uploadFiles() {
        // 기존 파일 입력 클릭으로 업로드 모달 실행
        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.click();
        } else {
            showNotification('파일 업로드 기능을 사용할 수 없습니다.', 'error');
        }
    }
}

// 전역 인스턴스 생성
const knowledgeManager = new KnowledgeManager();
window.knowledgeManager = knowledgeManager;


export { knowledgeManager };