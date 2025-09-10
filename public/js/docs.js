// Documentation page functionality
document.addEventListener('DOMContentLoaded', function() {
    
    // Back to top functionality
    const backToTop = document.getElementById('backToTop');
    
    if (backToTop) {
        window.addEventListener('scroll', function() {
            if (window.pageYOffset > 300) {
                backToTop.classList.add('visible');
            } else {
                backToTop.classList.remove('visible');
            }
        });
        
        backToTop.addEventListener('click', function(e) {
            e.preventDefault();
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        });
    }
    
    // Enhanced anchor navigation with proper offset
    const anchorLinks = document.querySelectorAll('a[href^="#"]');
    anchorLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href').substring(1);
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                // Calculate offset to account for any potential fixed headers
                const offsetTop = targetElement.offsetTop - 30;
                window.scrollTo({
                    top: Math.max(0, offsetTop),
                    behavior: 'smooth'
                });
                
                // Update URL hash without jumping
                history.pushState(null, null, '#' + targetId);
            }
        });
    });
    
    // Handle direct hash navigation (when page loads with hash)
    if (window.location.hash) {
        setTimeout(() => {
            const targetId = window.location.hash.substring(1);
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                const offsetTop = targetElement.offsetTop - 30;
                window.scrollTo({
                    top: Math.max(0, offsetTop),
                    behavior: 'smooth'
                });
            }
        }, 100);
    }
    
    // Add visual feedback for TOC links
    const tocLinks = document.querySelectorAll('#table-of-contents + ul a[href^="#"]');
    tocLinks.forEach(link => {
        link.addEventListener('mouseenter', function() {
            this.style.transform = 'translateX(5px)';
            this.style.transition = 'transform 0.2s ease';
        });
        
        link.addEventListener('mouseleave', function() {
            this.style.transform = 'translateX(0)';
        });
    });
    
    // Add keyboard navigation support
    document.addEventListener('keydown', function(e) {
        // Alt + T to go to Table of Contents
        if (e.altKey && e.key.toLowerCase() === 't') {
            e.preventDefault();
            const toc = document.getElementById('table-of-contents');
            if (toc) {
                toc.scrollIntoView({ behavior: 'smooth' });
                toc.focus();
            }
        }
        
        // Alt + H to go to top (Home)
        if (e.altKey && e.key.toLowerCase() === 'h') {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
    
    console.log('📚 Mock Server Documentation loaded');
    console.log('💡 Keyboard shortcuts: Alt+T (Table of Contents), Alt+H (Top)');
});